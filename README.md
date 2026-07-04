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
2. **Plan the camera** — each frame gets a target center point (players weighted
   by size, ball weighted up by the "follow the ball" slider). The raw path is
   smoothed with exponential smoothing + a max pan-speed cap so the camera
   glides instead of jumping.
3. **Render** — the source plays back while a moving 9:16 crop is drawn to a
   canvas and captured (with the original audio) into a downloadable clip.

See `js/tracker.js` (analysis + smoothing) and `js/renderer.js` (crop + encode).

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
- Only horizontal panning for now (full frame height is kept). Good for a fixed,
  elevated camera filming the court.
- Ball detection from a generic model is rough (the ball is tiny and fast). A
  future upgrade is swapping in **TrackNet**, a model trained specifically for
  tennis ball tracking, via ONNX Runtime Web.
- Output format is whatever the browser can record (mp4 on Safari/iOS, webm on
  Chrome/Android).

## Roadmap ideas

- TrackNet for real ball tracking; court-line detection to know in/out.
- Zoom (not just pan) so both players stay framed in wide rallies.
- Auto-trim dead time between rallies.
- Shot classification (forehand/backhand/serve) and, eventually, scoring.
