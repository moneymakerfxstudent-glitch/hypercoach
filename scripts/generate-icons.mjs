// Generates app icons via sharp from an SVG source.
// Run: node scripts/generate-icons.mjs
import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const ICON_DIR = 'public/icons';
mkdirSync(ICON_DIR, { recursive: true });

// Source SVG: chunky dumbbell glyph on orange background.
// Designed to read at 48px (favicon) up to 1024px (splash).
const ORANGE = '#f97316';
const BLACK = '#0a0a0a';
const WHITE = '#ffffff';

function buildSvg({ size, maskable = false, transparent = false }) {
  // Maskable icons need a safe zone — content within the inner 80% (10% padding each side).
  // We achieve this by scaling the dumbbell down inside a full-bleed orange tile.
  const scale = maskable ? 0.62 : 0.78;
  const cx = size / 2;
  const cy = size / 2;
  const dbW = size * scale;
  const dbH = dbW * 0.34;
  const barH = dbH * 0.18;
  const headW = dbH * 1.0;
  const headH = dbH * 0.95;
  const barLen = dbW - headW; // bar extends between the two heads
  const barX = cx - barLen / 2;
  const barY = cy - barH / 2;
  const headLX = cx - dbW / 2;
  const headRX = cx + dbW / 2 - headW;
  const headY = cy - headH / 2;
  const r = headW * 0.18;

  const bg = transparent
    ? '<rect width="100%" height="100%" fill="none"/>'
    : `<rect width="100%" height="100%" fill="${ORANGE}"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  ${bg}
  <g>
    <rect x="${barX}" y="${barY}" width="${barLen}" height="${barH}" fill="${BLACK}"/>
    <rect x="${headLX}" y="${headY}" width="${headW}" height="${headH}" rx="${r}" fill="${BLACK}"/>
    <rect x="${headRX}" y="${headY}" width="${headW}" height="${headH}" rx="${r}" fill="${BLACK}"/>
  </g>
</svg>`;
}

async function emit(name, size, opts = {}) {
  const svg = buildSvg({ size, ...opts });
  const buf = await sharp(Buffer.from(svg))
    .resize(size, size)
    .png()
    .toBuffer();
  const path = `${ICON_DIR}/${name}`;
  writeFileSync(path, buf);
  console.log(`  ${path}  (${size}×${size})`);
}

async function emitFavicon() {
  // ICO is messy; modern browsers happily use PNG favicons. We emit a 32px PNG.
  await emit('favicon-32.png', 32);
  await emit('favicon-16.png', 16);
}

console.log('Generating PWA icons...');
await emit('icon-192.png', 192);
await emit('icon-512.png', 512);
await emit('icon-maskable-192.png', 192, { maskable: true });
await emit('icon-maskable-512.png', 512, { maskable: true });
await emit('apple-touch-icon.png', 180);
await emitFavicon();
console.log('Done.');
