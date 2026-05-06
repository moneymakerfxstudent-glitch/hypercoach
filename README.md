# HyperCoach — Adaptive Hypertrophy PWA

Set-by-set adaptive hypertrophy coach. Logs your set, recommends the next one. Fully installable, works offline, all data stays on your device.

## Stack

- Vite + React 18
- Tailwind for styling
- `vite-plugin-pwa` for service worker + manifest generation (Workbox under the hood)
- `localStorage` for persistence

## Getting started

```bash
npm install
npm run dev          # http://localhost:5173 — SW disabled in dev
npm run build        # produces dist/ with hashed assets, manifest, and sw.js
npm run preview      # serves dist/ locally so you can test SW + install flow
```

The service worker is intentionally disabled during `vite dev` (set `devOptions.enabled: true` in `vite.config.js` if you want to test it). Always test PWA behavior with `npm run build && npm run preview`, or against a deployed build.

## Deploying

You need HTTPS in production — service workers won't register over HTTP. Any static host works (Vercel, Netlify, Cloudflare Pages, GitHub Pages with custom domain + HTTPS). Just point the host at `dist/`.

If you deploy to a subpath (e.g. `https://example.com/hypercoach/`), set `base: '/hypercoach/'` in `vite.config.js` and update the manifest's `start_url` and `scope` accordingly.

## Project structure

```
public/
  icons/                  PNG icons referenced by the manifest
src/
  HyperCoach.jsx          Main app (UI + recommendation engine)
  InstallModal.jsx        Platform-specific install instructions
  useInstallPrompt.js     Hook for beforeinstallprompt + standalone detection
  main.jsx                React entry
  index.css               Tailwind + safe-area handling
index.html                Manifest link, iOS meta tags, theme color
vite.config.js            VitePWA plugin config (manifest + workbox runtime caching)
scripts/generate-icons.mjs  Regenerate icons (run if you change the source SVG)
```

## Data

All workout history and settings live in `localStorage` under two keys:

- `hypercoach:history:v1` — array of completed workouts
- `hypercoach:settings:v1` — units, increment, rep targets

Nothing leaves the device. There's an Export option in Settings that downloads a JSON backup; you can restore by pasting the JSON into localStorage manually (a proper Import flow can be added later).

## Install instructions

The app shows these in-app via the Install button on Settings, but for reference:

### iPhone / iPad (Safari only)

1. Open the deployed URL in **Safari**. Chrome on iOS does not support PWA installs.
2. Tap the **Share** icon (the square with the up-arrow at the bottom of the screen).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add** in the top-right corner.

The icon appears on your home screen and launches in standalone mode (no Safari chrome).

### Android (Chrome)

If the browser supports it, an **Install HyperCoach** button will appear inside the app — one tap installs. Otherwise:

1. Tap the **three-dot menu** in Chrome's top-right.
2. Tap **Install app** (or **Add to Home screen** on older Android).
3. Confirm **Install**.

### Desktop (Chrome / Edge)

Look for the install icon on the right side of the address bar — a small monitor with a downward arrow. Click it, then click **Install**. The app opens in its own window.

## Updating the icon

Edit the SVG-generation logic in `scripts/generate-icons.mjs`, then run:

```bash
node scripts/generate-icons.mjs
```

You'll get fresh `icon-192.png`, `icon-512.png`, maskable variants, and the apple-touch-icon. Rebuild and redeploy to ship.

## Known limitations

- Custom font (Google Fonts) requires one online load to populate the runtime cache. After that it works offline.
- iOS doesn't expose a programmatic install prompt, so iOS users always go through the manual Share → Add to Home Screen flow.
- `localStorage` has a ~5MB cap. The data model is small (each set is a few hundred bytes); a year of daily training is well under 1MB. If you ever hit the limit, migrating to IndexedDB is straightforward.
