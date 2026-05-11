import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// PWA configuration tuned for an offline-first iOS Safari workout app.
//
// Goals:
// 1. After first install, the app must work with NO network — no Google Fonts,
//    no CDN assets, no PC server. Everything is local.
// 2. The service worker precaches the entire app shell at install time.
// 3. Updates happen automatically — when a new build deploys, the SW
//    activates the new version on the next reload.
// 4. SPA navigation is preserved offline via index.html fallback.

export default defineConfig({
  // Use relative base so the build works regardless of subpath deployment
  // (Cloudflare Pages root, Netlify root, GitHub Pages /repo/, etc.).
  base: './',

  plugins: [
    react(),
    VitePWA({
      // 'autoUpdate' makes the SW activate new versions silently. Combined with
      // skipWaiting + clientsClaim below, users get fresh code on the next
      // app open after a deploy without prompting.
      registerType: 'autoUpdate',

      // Files in /public/ that the SW should cache but that aren't already
      // pulled in by the manifest. Apple touch icon and favicons are linked
      // from index.html so iOS can render the home screen icon offline.
      includeAssets: [
        'icons/favicon-16.png',
        'icons/favicon-32.png',
        'icons/apple-touch-icon.png',
      ],

      manifest: {
        name: 'HyperCoach — Adaptive Hypertrophy',
        short_name: 'HyperCoach',
        description: 'Set-by-set adaptive hypertrophy coach. Works fully offline.',
        // Black theme color matches the app's dark UI; iOS uses this for
        // the status bar tint when launched from home screen.
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'portrait',
        // Relative paths so the manifest works on any deploy origin.
        start_url: '.',
        scope: '.',
        categories: ['fitness', 'health', 'lifestyle'],
        icons: [
          { src: 'icons/icon-192.png',           sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png',           sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-192.png',  sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png',  sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },

      workbox: {
        // Precache every asset Vite emits. Tiny app — full precache is fine.
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest,woff2}'],

        // SPA fallback: any navigation that doesn't match a precached file
        // gets index.html. Critical for offline route handling on iOS.
        navigateFallback: 'index.html',

        // When a new build is deployed, immediately replace the old cache.
        // Without this, iOS can hold on to a stale shell for days.
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,

        // No runtime caching of external resources — by design. Everything
        // the app needs is precached, so it works on first launch with
        // zero network. If you ever add an API later, this is where you
        // configure NetworkFirst / StaleWhileRevalidate strategies.
        runtimeCaching: [],
      },

      // Service worker is intentionally OFF in `vite dev` because dev SWs
      // cause confusing "why is my new code not loading" moments. Always
      // test PWA behavior with `npm run build && npm run preview`.
      devOptions: {
        enabled: false,
      },
    }),
  ],

  build: {
    // Smaller chunks help iOS's stricter cache quotas.
    chunkSizeWarningLimit: 600,
  },
});
