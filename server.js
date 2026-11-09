import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { renderJob, probeDuration } from './render.js';

const PORT = Number(process.env.PORT || 7860);
const WORK = process.env.WORK_DIR || path.join(os.tmpdir(), 'raw_edit_jobs');
const MAX_QUEUE = 5;
const MAX_ACTIVE = 1;
const TTL_MS = 60 * 60 * 1000;
const MAX_AUDIO_SECONDS = 20 * 60;

const jobs = new Map();
const queue = [];
const rate = new Map();
let active = 0;

await fsp.mkdir(WORK, { recursive: true });

const app = express();
app.disable('x-powered-by');

const IMG_RE = /^[A-Za-z0-9]{8}\.(png|jpg|jpeg|webp)$/i;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(WORK, req.jobId, file.fieldname === 'images' ? 'assets' : '');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    if (file.fieldname === 'audio') {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
      return cb(null, 'audio' + ext);
    }
    if (file.fieldname === 'code') return cb(null, 'code.html');
    if (file.fieldname === 'layers') return cb(null, 'layers.json');
    if (file.fieldname === 'images' && IMG_RE.test(file.originalname)) {
      return cb(null, file.originalname);
    }
    cb(new Error('bad_file'));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024, files: 23 },
  fileFilter: (req, file, cb) => {
    const lim = { audio: 50, code: 5, layers: 1, images: 10 }[file.fieldname];
    lim ? cb(null, true) : cb(new Error('bad_field'));
  }
}).fields([
  { name: 'audio', maxCount: 1 },
  { name: 'code', maxCount: 1 },
  { name: 'layers', maxCount: 1 },
  { name: 'images', maxCount: 20 }
]);

function rateOk(id) {
  const now = Date.now();
  const list = (rate.get(id) || []).filter((t) => now - t < 3600e3);
  if (list.length >= 5) return false;
  list.push(now);
  rate.set(id, list);
  return true;
}

app.get('/health', (req, res) => res.json({ ok: true, queue: queue.length, active }));

app.post(
  '/jobs',
  (req, res, next) => {
    const dev = String(req.get('X-Device-Id') || '').slice(0, 64);
    if (!/^[0-9a-f-]{16,64}$/i.test(dev)) return res.status(400).json({ error: 'bad_device' });
    if (!rateOk(dev)) return res.status(429).json({ error: 'rate_limited' });
    if (queue.length >= MAX_QUEUE) return res.status(503).json({ error: 'busy' });
    req.jobId = crypto.randomUUID();
    next();
  },
  (req, res) =>
    upload(req, res, async (err) => {
      const dir = path.join(WORK, req.jobId);
      try {
        if (err) throw Object.assign(err, { code2: 400 });
        const f = req.files || {};
        if (!f.audio?.[0] || !f.code?.[0]) {
          throw Object.assign(new Error('missing_files'), { code2: 400 });
        }
        const audio = f.audio[0].path;
        const dur = await probeDuration(audio);
        if (!(dur > 0.5)) throw Object.assign(new Error('bad_audio'), { code2: 400 });
        if (dur > MAX_AUDIO_SECONDS) throw Object.assign(new Error('too_long'), { code2: 413 });

        const job = {
          id: req.jobId,
          dir,
          audio,
          duration: dur,
          status: 'queued',
          percent: 0,
          message: 'Waiting in line',
          cancelled: false,
          createdAt: Date.now(),
          killers: []
        };
        jobs.set(job.id, job);
        queue.push(job.id);
        pump();
        res.status(202).json({ jobId: job.id });
      } catch (e) {
        await fsp.rm(dir, { recursive: true, force: true });
        res.status(e.code2 || 500).json({ error: e.message || 'error' });
      }
    })
);

app.get('/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'not_found' });
  res.json({
    status: j.status,
    percent: Math.round(j.percent),
    message: j.message,
    queuePosition: Math.max(0, queue.indexOf(j.id) + 1),
    etaSeconds: j.eta ?? null
  });
});

app.get('/jobs/:id/video', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== 'done') return res.status(404).json({ error: 'not_ready' });
  res.sendFile(path.join(j.dir, 'final.mp4'));
});

app.delete('/jobs/:id', async (req, res) => {
  const j = jobs.get(req.params.id);
  if (j) {
    j.cancelled = true;
    j.status = 'cancelled';
    try {
      j.killers?.forEach((k) => {
        try {
          k();
        } catch {}
      });
    } catch {}
    const at = queue.indexOf(j.id);
    if (at >= 0) queue.splice(at, 1);
    await fsp.rm(j.dir, { recursive: true, force: true });
    jobs.delete(j.id);
  }
  res.json({ ok: true });
});

async function pump() {
  while (active < MAX_ACTIVE && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job || job.cancelled) continue;
    active++;
    (async () => {
      const timer = setTimeout(() => {
        job.cancelled = true;
        try {
          job.killers?.forEach((k) => k());
        } catch {}
      }, 40 * 60 * 1000);
      try {
        await renderJob(job);
        if (!job.cancelled) {
          job.status = 'done';
          job.percent = 100;
          job.message = 'Done';
        }
      } catch (e) {
        if (!job.cancelled) {
          job.status = 'error';
          job.message = String(e.message || e).slice(0, 200);
        }
      } finally {
        clearTimeout(timer);
        active--;
        pump();
      }
    })();
  }
}

setInterval(async () => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (now - j.createdAt > TTL_MS) {
      await fsp.rm(j.dir, { recursive: true, force: true }).catch(() => {});
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => console.log('raw_edit_server on ' + PORT));
