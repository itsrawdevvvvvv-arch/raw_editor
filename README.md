# raw_edit_server

The render server for **raw_edit**. The phone uploads a voiceover, one HTML file and
(optionally) a layers JSON and images; this server draws every frame in headless Chromium,
encodes with FFmpeg and returns a 1920x1080 MP4.

Free to run, no accounts, nothing stored permanently.

## API

| Method and path | Purpose |
| --- | --- |
| `GET /health` | `{ "ok": true, "queue": 0, "active": 0 }` |
| `POST /jobs` | multipart upload, returns `{ "jobId": "<uuid>" }` (202) |
| `GET /jobs/:id` | `{ status, percent, message, queuePosition, etaSeconds }` |
| `GET /jobs/:id/video` | streams the MP4 when status is `done` |
| `DELETE /jobs/:id` | cancels and deletes the job |

`POST /jobs` fields: `audio` (mp3/m4a/wav/aac, up to 50 MB), `code` (html, up to 5 MB),
`layers` (optional JSON), `images` (0-20 files named `<8 chars>.<png|jpg|jpeg|webp>`,
10 MB each). Send an `X-Device-Id` header with a random UUID.

Limits: 20 minutes of audio, 1 active render, queue of 5, 5 jobs per device per hour,
40 minute job timeout, jobs deleted 60 minutes after creation.

## Run locally

```bash
npm install
npm start                     # http://localhost:7860
npm test                      # end to end smoke test, needs ffmpeg and ffprobe
```

`FFMPEG_PATH` and `FFPROBE_PATH` let you point at a bundled binary if they are not on PATH.

## Deploy free on Oracle Cloud Always Free

Oracle's Always Free tier gives an Ampere A1 ARM VM (up to 4 cores and 24 GB RAM, free
forever). It asks for a card for identity verification only; it is not charged.

1. Create an account at cloud.oracle.com and pick a home region.
2. Create an instance: **Ampere A1.Flex**, 4 OCPUs, 12-24 GB RAM, Ubuntu 22.04 ARM.
   Download the SSH key.
3. Open the firewall: in the VCN security list add an ingress rule for TCP port 7860
   from `0.0.0.0/0`. On the VM also run
   `sudo iptables -I INPUT 6 -p tcp --dport 7860 -j ACCEPT` (Ubuntu images ship with
   iptables rules that block it).
4. Install Docker:
   `curl -fsSL https://get.docker.com | sudo sh`
5. Copy this repository to the VM, then:
   ```bash
   sudo docker build -t raw-edit-server .
   sudo docker run -d --restart always --name raw-edit-server \
     -p 7860:7860 --memory=6g raw-edit-server
   ```
6. Check `curl http://<public-ip>:7860/health`.
7. Put `http://<public-ip>:7860` into `ServerConfig.BASE_URL` in the Android app.

To use HTTPS, put Caddy in front (`caddy reverse-proxy --from your.domain --to :7860`).

## What has been verified

Measured on a 2 vCPU / 2 GB container with headless Chromium:

| Test | Result |
| --- | --- |
| `npm test` end to end (6 s clip, 180 frames) | PASS: 1920x1080, 30 fps, audio present, 6.07 s, 0.9 MB |
| Render speed on that weak machine | 180 frames in 133 s (~1.4 fps) |
| Network blocked inside the page | Yes, every request except the injected page is aborted |
| Fonts | Montserrat Bold and Open Sans are installed in the image with `fc-cache` |

Extrapolated, not measured on Oracle hardware: a 30 second clip is about 900 frames, so
roughly 10 minutes on a 2 core box and likely 3-5 minutes on a 4 core Ampere VM. Treat those
as estimates until you measure them.

## Security

- Pasted code runs only inside headless Chromium in the container. Every network request is
  aborted except `https://raw.local/index.html` and the job's own `https://assets.local/` files.
- The container runs as the unprivileged `pwuser`. Chromium runs with `--no-sandbox`, which is
  acceptable only because the container itself is the sandbox.
- Uploads are validated by field name, extension, size and image filename regex; audio is
  checked with ffprobe. No shell strings are built from user input, only `spawn` with arrays.
- No logs of file contents, no accounts, jobs deleted after one hour.

## Licences

Montserrat and Open Sans are bundled under the SIL Open Font License 1.1. Express (MIT),
Multer (MIT), Playwright (Apache-2.0), FFmpeg (LGPL/GPL as built by the base image).
