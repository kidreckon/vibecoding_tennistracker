# 🎾 Rally Reframe

A free, install-free **mobile web app (PWA)** that turns landscape (16:9) tennis
footage into a **vertical 9:16 clip that automatically follows the action** —
the player(s) and, when visible, the ball. Everything runs **on your phone, in
the browser**. No account, no upload, no server, no cost.

This is the MVP of a SwingVision-style auto-reframe tool. It does **not** need
any AI training — it uses a pre-trained detector (COCO-SSD, which already knows
`person` and `sports ball`) plus a smoothing "virtual camera operator".

## How it works

1. **Analyze** — the video is stepped through frame by frame; a pre-trained
   model detects players and the ball in each sampled frame.
2. **Plan the camera** — each frame gets a target framing: a **center** (players'
   box center, nudged toward the ball by the "follow the ball" slider) and a
   **zoom** (crop height sized to contain the action — tight on one player, wider
   for a spread-out rally). Center *and* zoom are smoothed with exponential
   smoothing + max-speed caps so the camera glides instead of jumping.
3. **Auto-trim** — a per-frame activity score (how much the action moves, plus a
   ball-visible nudge) flags dead time; low-activity spans are dropped and the
   kept segments get a small margin so cuts aren't abrupt.
4. **Render** — the source plays back while the moving/zooming 9:16 crop is drawn
   to a canvas and captured (with the original audio) into a downloadable clip.
   Dead segments are skipped by seeking across them mid-recording.

See `js/tracker.js` (framing, zoom, smoothing, segments) and `js/renderer.js`
(crop + encode).

### Controls
- **Zoom to the action** — pan *and* zoom (off = pan only, full frame height).
- **Auto-trim dead time** — drop the gaps between rallies.
- **Follow the ball** / **Camera smoothness** — framing bias and glide amount.

## Try it locally

It's static files — any static server works:

```bash
python3 -m http.server 8000
# then open http://localhost:8000 on your computer,
# or http://<your-computer-ip>:8000 on your phone (same Wi-Fi)
```

> The camera/recording APIs need a **secure context**. `localhost` counts as
> secure; to test from your phone over the network use HTTPS (e.g. deploy to
> GitHub Pages below) or a tunnel like `ngrok`.

## Put it on your phone (free hosting)

**GitHub Pages** is the easiest free host and gives you HTTPS:

1. Push this branch and merge to your default branch.
2. Repo → **Settings → Pages** → Source: *Deploy from a branch* → your default
   branch, `/ (root)` → Save.
3. Open the given `https://<user>.github.io/<repo>/` URL on your phone.
4. In the browser menu tap **Add to Home Screen** — now it launches like an app
   and works offline.

## Notes & limits (MVP)

- Best on **short clips** (a rally or ~30–60s). In-browser processing is slower
  and more memory-limited than a desktop; long matches should be split up.
- Auto-trim uses one continuous recording and seeks across dead spans, so each
  cut has a brief (~fraction of a second) freeze/audio-jump. A future upgrade is
  `ffmpeg.wasm` to render segments and concatenate them cleanly (and get
  consistent mp4 output on every browser).
- Ball detection from a generic model is rough (the ball is tiny and fast). A
  future upgrade is swapping in **TrackNet**, a model trained specifically for
  tennis ball tracking, via ONNX Runtime Web.
- Output format is whatever the browser can record (mp4 on Safari/iOS, webm on
  Chrome/Android).

## Roadmap ideas

- TrackNet for real ball tracking; court-line detection to know in/out.
- `ffmpeg.wasm` for glitch-free trimmed cuts + consistent mp4 output.
- Shot classification (forehand/backhand/serve) and, eventually, scoring.
