/**
 * End to end smoke test.
 *
 * Starts the server, uploads a generated voice track plus the reference
 * composition, waits for the job, downloads the MP4 and checks it with ffprobe:
 * 1920x1080, 30 fps, an audio stream, and the right duration.
 *
 * Run with: npm test
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const PORT = process.env.TEST_PORT || '7861';
const BASE = 'http://127.0.0.1:' + PORT;
const DURATION = 6;

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'rawedit-smoke-'));
const audioPath = path.join(tmp, 'voice.mp3');

function fail(msg) {
  console.error('FAIL: ' + msg);
  process.exit(1);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(err.slice(-400)))));
  });
}

// 1. a voice track to render against
await run(FFMPEG, [
  '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=' + DURATION,
  '-c:a', 'libmp3lame', '-b:a', '128k', audioPath
]);
console.log('voice track ready');

// 2. start the server
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT,
    WORK_DIR: path.join(tmp, 'jobs'),
    FFMPEG_PATH: FFMPEG,
    FFPROBE_PATH: FFPROBE
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

let exited = false;
server.on('exit', (c) => {
  exited = true;
  if (c) console.error('server exited with ' + c);
});

async function waitHealthy(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (exited) throw new Error('server died');
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('server did not become healthy');
}

try {
  await waitHealthy();
  console.log('server healthy');

  // 3. upload
  const code = await fsp.readFile(path.join(ROOT, 'sample/reference.html'));
  const form = new FormData();
  form.append('audio', new Blob([await fsp.readFile(audioPath)], { type: 'audio/mpeg' }), 'voice.mp3');
  form.append('code', new Blob([code], { type: 'text/html' }), 'code.html');

  const started = Date.now();
  const created = await fetch(BASE + '/jobs', {
    method: 'POST',
    headers: { 'X-Device-Id': crypto.randomUUID() },
    body: form
  });
  if (created.status !== 202) fail('POST /jobs returned ' + created.status + ' ' + (await created.text()));
  const { jobId } = await created.json();
  console.log('job ' + jobId + ' queued');

  // 4. poll
  let status = 'queued';
  let percent = 0;
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    const r = await fetch(BASE + '/jobs/' + jobId);
    if (!r.ok) fail('poll returned ' + r.status);
    const s = await r.json();
    if (s.percent !== percent) {
      percent = s.percent;
      process.stdout.write('\r  ' + s.status + ' ' + s.percent + '% ' + (s.message || '') + '        ');
    }
    status = s.status;
    if (status === 'done') break;
    if (status === 'error') fail('job error: ' + s.message);
    await new Promise((r2) => setTimeout(r2, 500));
  }
  console.log('');
  if (status !== 'done') fail('timed out, last status ' + status);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // 5. download
  const video = await fetch(BASE + '/jobs/' + jobId + '/video');
  if (!video.ok) fail('video download returned ' + video.status);
  const outPath = path.join(tmp, 'final.mp4');
  await fsp.writeFile(outPath, Buffer.from(await video.arrayBuffer()));
  const stat = await fsp.stat(outPath);
  console.log('downloaded ' + (stat.size / 1048576).toFixed(1) + ' MB in ' + elapsed + ' s');

  // 6. verify
  const probe = JSON.parse(
    await run(FFPROBE, [
      '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', outPath
    ])
  );
  const v = probe.streams.find((s) => s.codec_type === 'video');
  const a = probe.streams.find((s) => s.codec_type === 'audio');
  const dur = parseFloat(probe.format.duration);

  if (!v) fail('no video stream');
  if (v.width !== 1920 || v.height !== 1080) fail('video is ' + v.width + 'x' + v.height);
  const fps = v.r_frame_rate.split('/').reduce((n, d, i, arr) => (i === 0 ? n / arr[1] : n));
  if (Math.abs(Number(v.r_frame_rate.split('/')[0]) / Number(v.r_frame_rate.split('/')[1]) - 30) > 0.1) {
    fail('fps is ' + v.r_frame_rate);
  }
  if (!a) fail('no audio stream');
  if (Math.abs(dur - DURATION) > 0.2) fail('duration is ' + dur + 's, expected ' + DURATION);

  console.log('PASS  1920x1080, 30 fps, audio present, ' + dur.toFixed(2) + 's, ' + (stat.size / 1048576).toFixed(1) + ' MB');
  process.exitCode = 0;
} catch (e) {
  fail(e.message);
} finally {
  try {
    server.kill('SIGKILL');
  } catch {}
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
}
