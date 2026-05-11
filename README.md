# HyperCoach — Offline-First iOS PWA

Set-by-set adaptive hypertrophy coach. **Works fully offline after install.** No PC server, no localhost, no internet required during workouts.

## What you get

- iPhone home-screen app, launches full-screen with no Safari chrome
- Service worker precaches the entire app shell on first visit
- All workout data stored locally in `localStorage` — never leaves your device
- System fonts only (SF Pro on iOS) — zero external dependencies
- Persistent storage requested automatically to fight iOS eviction
- **Per-exercise loading profiles** — never recommends impossible weights.
  Configure each exercise's actual equipment (machine stack, dumbbells,
  plates, decimal Matrix stacks, etc.) under Settings → Exercise Loading.
- **Pause & resume workouts** — exit anytime; the app saves your progress
  as paused, surfaces a Resume card on Home, and only marks workouts as
  completed when you explicitly tap Finish.
- **Edit completed workouts** — tap any session in History to fix typos,
  add missed sets, or rename exercises. PRs, e1RM, and next-workout
  recommendations recompute automatically from your edits.

## Architecture, in short

```
your iPhone
    └── Home Screen icon
            └── Standalone webview (offline-capable)
                    ├── App shell (precached by service worker)
                    └── localStorage (workout history, settings)
```

After first install, **nothing on the network is required**. The app boots from cache, runs from cache, and writes only to localStorage.

---

## Step 1 — Build the app

You only need a computer for this once. After deploy, you never need your PC again.

```bash
# In the project folder
npm install
npm run build
```

This produces a `dist/` folder containing:
- `index.html`
- `assets/*.js`, `assets/*.css` — hashed bundles
- `sw.js` — service worker
- `manifest.webmanifest` — PWA manifest
- `icons/*.png` — all icon sizes

Everything in `dist/` is static. No backend, no Node.js needed at runtime.

## Step 2 — Deploy to a free HTTPS host

iOS service workers **require HTTPS**. Your home Wi-Fi or PC IP won't work. The free options below all give you HTTPS automatically and take ~2 minutes.

Pick **one** of these. I recommend **Cloudflare Pages** for stability and **Netlify drop** for speed.

### Option A — Cloudflare Pages (recommended, 5 min)

1. Sign up at https://dash.cloudflare.com/sign-up (free, no credit card).
2. Push this project to a GitHub repo.
3. In Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect to Git**.
4. Select your repo. Set:
   - Build command: `npm run build`
   - Build output: `dist`
5. Click Save and Deploy. You get `https://hypercoach-xxx.pages.dev`.

Every `git push` redeploys automatically.

### Option B — Netlify Drop (fastest, no Git needed)

1. Run `npm run build` locally.
2. Open https://app.netlify.com/drop in any browser.
3. Drag the `dist/` folder onto the page.
4. You get `https://something-random-xxx.netlify.app` instantly with HTTPS.

### Option C — Vercel CLI

```bash
npm install -g vercel
npm run build
vercel deploy --prod
# Follow prompts; pick the dist folder as output
```

### Option D — GitHub Pages (custom domain required for PWA)

GitHub Pages on a `*.github.io` URL works, but the SW scope can be tricky on subpaths. If you go this route, set `base: '/<your-repo-name>/'` in `vite.config.js`. Easiest avoided unless you already use it.

---

## Step 3 — Install on iPhone

After Step 2 you have an HTTPS URL like `https://hypercoach-xxx.pages.dev`.

**On your iPhone:**

1. Open **Safari** (not Chrome — iOS only allows PWA installs from Safari).
2. Type or paste your URL into the address bar and load the page.
3. Wait ~5 seconds. The service worker registers and precaches the app — you'll see this happen automatically.
4. Tap the **Share** icon at the bottom of the screen (square with up-arrow).
5. Scroll down and tap **Add to Home Screen**.
6. Tap **Add** in the top-right corner.

The HyperCoach icon appears on your home screen. Tap it.

The app launches **full-screen**, with no Safari address bar, no tabs, no chrome. It looks and feels like a native app.

## Step 4 — Verify offline mode

Now prove it works without a server:

1. On your iPhone, swipe up to open Control Center.
2. Turn on **Airplane Mode**.
3. Tap the HyperCoach icon on your home screen.

The app should launch, look identical, and let you log a full workout. Sets save, history shows, recommendations work.

Reopen Settings inside the app — the **App Status** card will show:
- ✅ Installed · running standalone
- ✅ Offline — app still works
- ✅ Storage marked persistent · safe from auto-eviction

You're done. Your iPhone now has a fully self-contained workout coach that doesn't depend on your PC, your home network, or anything else.

---

## What's actually happening

### Service worker

`vite-plugin-pwa` generates a Workbox-based service worker at build time (`dist/sw.js`). On first visit:

1. Browser downloads the SW
2. SW intercepts the precache list and downloads every JS/CSS/HTML/image into the Cache Storage API
3. SW becomes active
4. Subsequent navigations are served from cache, network bypassed entirely

The SW config lives in `vite.config.js`:

- `registerType: 'autoUpdate'` — when you ship a new build, users get it on next launch
- `cleanupOutdatedCaches: true` — old SW caches get purged
- `navigateFallback: 'index.html'` — SPA routing works offline
- `runtimeCaching: []` — intentionally empty, **the app uses no external resources**

### Storage

Two `localStorage` keys:

- `hypercoach:history:v1` — array of completed workouts
- `hypercoach:settings:v1` — units, increments, rep targets

That's it. No backend, no sync, no servers.

### iOS persistence quirk

iOS evicts script-writable storage after ~7 days of non-use, **unless** the page is added to the home screen and `navigator.storage.persist()` returns true. We call this on every app launch (see `useInstallPrompt.js`). After installation, iOS grants persistent storage automatically. The Settings screen confirms this.

---

## Local-only testing (without deploy)

If you want to verify the build before deploying:

```bash
npm run build
npm run preview
# Opens http://localhost:4173
```

The SW works on `localhost` (browsers grant it secure-context status there). But to test on **your iPhone over Wi-Fi**, you need HTTPS — and that's what Step 2 is for.

Some devs use `ngrok http 4173` for a temporary HTTPS tunnel during testing. That's fine for verification but **not the goal here** — your phone shouldn't need your PC to be running.

---

## Updating the app

After first install, when you push a new build:

1. The SW detects the new version on next page load
2. Downloads the new files in the background
3. Activates the new version (skipWaiting + clientsClaim ensure no double-load required)
4. Next time the user opens the app, they're on the new version

No App Store, no review process, no update prompts. Ship as often as you want.

---

## Project layout

```
public/
  icons/                    PNG icons for manifest + apple-touch
src/
  HyperCoach.jsx            Main app
  InstallModal.jsx          Platform-specific install instructions
  useInstallPrompt.js       beforeinstallprompt + persistent storage
  main.jsx                  React entry + SW registration
  index.css                 Tailwind + system-font display class
index.html                  iOS PWA meta tags
vite.config.js              VitePWA config (Workbox SW + manifest)
scripts/generate-icons.mjs  Regenerate icons from inline SVG
```

## Known iOS limitations (worth knowing)

- **Cache cap**: Safari historically capped Cache Storage at ~50MB per origin. Safari 17+ allows much more, but stay lean. Our build is well under 1MB total.
- **Home Screen launch only**: PWA features (offline, persistent storage, full-screen) only apply when launched from the home screen icon. Opening the same URL in a Safari tab won't behave the same way.
- **No background sync**: iOS service workers can't run while the app is closed. We don't need this — the app is fully synchronous.
- **Updates need an open**: SW updates check on app launch. The app must be opened at least once to pull a new version.

## When something goes wrong

**App doesn't work offline after install.**
The SW didn't finish caching before you went offline. Open Safari with internet, navigate to the URL, wait 10 seconds, then try again.

**App looks broken / old version showing.**
SW cache stale. In Safari: Settings → Safari → Advanced → Website Data → search HyperCoach → delete. Then reinstall from home screen.

**Add to Home Screen option missing.**
You're using Chrome on iOS. Open the URL in **Safari** instead — iOS only supports PWA install from Safari directly.

**App opens in Safari with the address bar showing.**
You opened the bookmark, not the home screen icon. Or `display: standalone` isn't being honored — check the manifest is loading (Safari → Develop → Show Web Inspector when phone is connected via USB).
