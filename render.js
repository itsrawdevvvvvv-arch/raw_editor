import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const FPS = 30;
const W = 1920;
const H = 1080;

// Allow a bundled ffmpeg (Oracle VM, containers without ffmpeg on PATH).
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', (c) => (c === 0 ? resolve(parseFloat(out)) : reject(new Error('bad_audio'))));
    p.on('error', () => reject(new Error('bad_audio')));
  });
}

/** Video bitrate target in kbps, chosen to hit the size goals in the brief. */
function targetKbps(seconds) {
  if (seconds <= 60) return 5000;
  if (seconds <= 180) return 3500;
  return 2800;
}

async function renderSegment({ browser, job, code, layers, from, to, outFile, onFrame, kbps }) {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1
  });

  // Everything except the injected page and the job's own assets is blocked.
  await ctx.route('**/*', (route) => {
    const url = route.request().url();
    if (url === 'https://raw.local/index.html') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: code });
    }
    if (url.startsWith('https://assets.local/')) {
      const name = path.basename(new URL(url).pathname);
      if (/^[A-Za-z0-9]{8}\.(png|jpg|jpeg|webp)$/i.test(name)) {
        return route
          .fulfill({ path: path.join(job.dir, 'assets', name) })
          .catch(() => route.abort());
      }
    }
    return route.abort();
  });

  const page = await ctx.newPage();
  page.on('pageerror', () => {});
  await page.goto('https://raw.local/index.html', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.RAW && typeof window.RAW.seek === 'function', null, {
    timeout: 15000
  });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  if (layers) await page.evaluate((L) => { window.RAW.layers = L; }, layers);
  const dur = await page.evaluate(() => window.RAW.duration || 0);

  const ff = spawn(
    FFMPEG,
    [
      '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-b:v', kbps + 'k', '-maxrate', Math.round(kbps * 1.5) + 'k', '-bufsize', kbps * 2 + 'k',
      '-g', String(FPS), '-keyint_min', String(FPS), '-sc_threshold', '0',
      '-an', outFile
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] }
  );

  let ffErr = '';
  ff.stderr.on('data', (d) => { ffErr = (ffErr + d).slice(-2000); });
  const closed = new Promise((res, rej) =>
    ff.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg: ' + ffErr.slice(-300)))))
  );
  job.killers.push(() => ff.kill('SIGKILL'));

  for (let i = from; i < to; i++) {
    if (job.cancelled) break;
    const t = Math.min(i / FPS, dur);
    await page.evaluate((tt) => window.RAW.seek(tt), t);
    if (await page.evaluate(() => document.images.length)) {
      await page.evaluate(() =>
        Promise.all([...document.images].map((im) => im.decode().catch(() => {})))
      );
    }
    const buf = await page.screenshot({ type: 'jpeg', quality: 90 });
    if (!ff.stdin.write(buf)) await once(ff.stdin, 'drain');
    onFrame();
  }

  ff.stdin.end();
  await closed;
  await ctx.close();
}

export async function renderJob(job) {
  job.killers = job.killers || [];
  job.kill = () => job.killers.forEach((k) => { try { k(); } catch {} });

  job.status = 'rendering';
  job.message = 'Drawing frames';
  job.percent = 1;

  const code = await fsp.readFile(path.join(job.dir, 'code.html'), 'utf8');
  let layers = null;
  try {
    layers = JSON.parse(await fsp.readFile(path.join(job.dir, 'layers.json'), 'utf8'));
  } catch {}

  const total = Math.ceil(job.duration * FPS);
  const kbps = targetKbps(job.duration);
  const workers = Math.max(1, Math.min(3, os.cpus().length));

  const browser = await chromium.launch({
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--host-resolver-rules=MAP * ~NOTFOUND'
    ]
  });
  job.killers.push(() => browser.close().catch(() => {}));

  let done = 0;
  const t0 = Date.now();
  const onFrame = () => {
    done++;
    job.percent = (done / total) * 92;
    const el = (Date.now() - t0) / 1000;
    job.eta = done > 90 ? Math.round((el / done) * (total - done)) : null;
  };

  try {
    const per = Math.ceil(total / workers);
    const parts = [];
    const tasks = [];
    for (let w = 0; w < workers; w++) {
      const from = w * per;
      const to = Math.min(total, from + per);
      if (from >= to) continue;
      const outFile = path.join(job.dir, 'seg' + w + '.mp4');
      parts.push(outFile);
      tasks.push(
        renderSegment({ browser, job, code, layers, from, to, outFile, onFrame, kbps })
      );
    }
    await Promise.all(tasks);
    if (job.cancelled) return;

    job.status = 'encoding';
    job.message = 'Adding your voice';
    job.percent = 94;

    parts.sort();
    const listPath = path.join(job.dir, 'list.txt');
    await fsp.writeFile(listPath, parts.map((p) => "file '" + p + "'").join('\n'));

    const finalPath = path.join(job.dir, 'final.mp4');
    await new Promise((res, rej) => {
      const p = spawn(FFMPEG, [
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-i', job.audio,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k',
        '-t', String(job.duration), '-movflags', '+faststart', finalPath
      ]);
      job.killers.push(() => p.kill('SIGKILL'));
      let err = '';
      p.stderr.on('data', (d) => { err = (err + d).slice(-1500); });
      p.on('close', (c) => (c === 0 ? res() : rej(new Error('mux_failed: ' + err.slice(-200)))));
    });

    const st = await fsp.stat(finalPath);
    if (!st.size) throw new Error('empty_output');
    job.renderMs = Date.now() - t0;
  } finally {
    await browser.close().catch(() => {});
  }
}
