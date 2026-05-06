import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// vite-plugin-pwa generates the service worker (via Workbox) and the
// web manifest at build time, hashing precached assets so updates take
// effect when the user next loads the app.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Anything in /public that isn't picked up by the manifest itself
      // needs to be listed here so the SW caches it on install.
      includeAssets: [
        'icons/favicon-16.png',
        'icons/favicon-32.png',
        'icons/apple-touch-icon.png',
      ],
      manifest: {
        name: 'HyperCoach — Adaptive Hypertrophy',
        short_name: 'HyperCoach',
        description: 'Set-by-set adaptive hypertrophy coach. Tells you what to lift next based on what you just lifted.',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        categories: ['fitness', 'health', 'lifestyle'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: 'icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache everything Vite emits.
        globPatterns: ['**/*.{js,css,html,png,svg,woff2}'],
        // Navigations fall back to index.html when offline (SPA shell).
        navigateFallback: '/index.html',
        // Google Fonts are external — runtime cache them so the typography
        // survives offline use after the first load.
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-stylesheets',
              expiration: { maxEntries: 10, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        // Set true if you want to test the SW during `vite dev`.
        // Default false because dev SWs cause confusing cache behavior.
        enabled: false,
      },
    }),
  ],
});
