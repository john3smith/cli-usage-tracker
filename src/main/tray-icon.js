'use strict';

const zlib = require('zlib');

// Precompute CRC32 table for valid PNG chunks
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    makeChunk('IHDR', ihdr),
    makeChunk('IDAT', compressed),
    makeChunk('IEND', Buffer.alloc(0)),
  ]);
}

function setPixel(rgba, size, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  const idx = (y * size + x) * 4;
  if (a === 255) {
    rgba[idx] = r;
    rgba[idx + 1] = g;
    rgba[idx + 2] = b;
    rgba[idx + 3] = 255;
    return;
  }
  const alpha = a / 255;
  const inv = 1 - alpha;
  rgba[idx] = Math.round(r * alpha + rgba[idx] * inv);
  rgba[idx + 1] = Math.round(g * alpha + rgba[idx + 1] * inv);
  rgba[idx + 2] = Math.round(b * alpha + rgba[idx + 2] * inv);
  rgba[idx + 3] = Math.min(255, Math.round(a + rgba[idx + 3] * inv));
}

function fillRoundedRect(rgba, size, x0, y0, w, h, radius, color) {
  const [r, g, b, a = 255] = color;
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let dx = 0;
      let dy = 0;
      if (x < x0 + radius && y < y0 + radius) {
        dx = x0 + radius - x;
        dy = y0 + radius - y;
      } else if (x > x1 - radius && y < y0 + radius) {
        dx = x - (x1 - radius);
        dy = y0 + radius - y;
      } else if (x < x0 + radius && y > y1 - radius) {
        dx = x0 + radius - x;
        dy = y - (y1 - radius);
      } else if (x > x1 - radius && y > y1 - radius) {
        dx = x - (x1 - radius);
        dy = y - (y1 - radius);
      }
      if (dx * dx + dy * dy <= radius * radius) {
        setPixel(rgba, size, x, y, r, g, b, a);
      }
    }
  }
}

function getBarColor(provider, fallbackId) {
  const id = provider?.id || fallbackId;
  if (!provider || provider.status !== 'connected' || !provider.windows?.length) {
    return null; // Not logged in -> do not draw filled bar
  }
  const minRemaining = Math.min(
    ...provider.windows.map((w) => Number(w.remainingPercent ?? (100 - (Number(w.usedPercent) || 0))))
  );
  if (minRemaining <= 15) return [244, 63, 94, 255]; // rose alert
  if (minRemaining <= 35) return [245, 158, 11, 255]; // amber warning

  if (id === 'gpt') return [16, 185, 129, 255]; // emerald
  if (id === 'agy') return [59, 130, 246, 255]; // blue
  return [234, 138, 86, 255]; // claude warm coral
}

function getBarFillRatio(provider) {
  if (!provider || provider.status !== 'connected' || !provider.windows?.length) {
    return 0; // Logged out -> no remaining bar drawn
  }
  const primary = provider.windows[0];
  const remaining = Math.max(0, Math.min(100, Number(primary.remainingPercent ?? (100 - (primary.usedPercent || 0)))));
  return remaining / 100;
}

function computeTrayVisualKey(providers = {}) {
  return ['gpt', 'agy', 'claude']
    .map((id) => {
      const p = providers[id];
      const status = p?.status || 'none';
      const ratio = Math.round(getBarFillRatio(p) * 20);
      const color = getBarColor(p, id);
      return `${id}:${status}:${ratio}:${color ? color.join(',') : 'none'}`;
    })
    .join('|');
}

function renderIconPngAtSize(providers = {}, size = 32) {
  const rgba = Buffer.alloc(size * size * 4, 0);
  const scale = size / 32;

  const rOuter = Math.max(2, Math.round(7 * scale));
  const rInner = Math.max(2, Math.round(6 * scale));
  const pad1 = Math.max(1, Math.round(1 * scale));
  const pad2 = Math.max(2, Math.round(2 * scale));

  // Rounded dark badge with bright subtle rim (visible on both light and dark Windows 11 taskbars)
  fillRoundedRect(rgba, size, pad1, pad1, size - pad1 * 2, size - pad1 * 2, rOuter, [100, 116, 139, 255]);
  fillRoundedRect(rgba, size, pad2, pad2, size - pad2 * 2, size - pad2 * 2, rInner, [17, 22, 31, 255]);

  const ids = ['gpt', 'agy', 'claude'];
  const barWidth = Math.max(2, Math.round(5 * scale));
  const barHeight = Math.max(8, Math.round(20 * scale));
  const startY = Math.round(6 * scale);
  const barRadius = Math.max(1, Math.round(1.5 * scale));
  const xs = [
    Math.round(6 * scale),
    Math.round(13.5 * scale),
    Math.round(21 * scale),
  ];

  for (let i = 0; i < 3; i++) {
    const id = ids[i];
    const provider = providers[id];
    const x = xs[i];

    // Background track
    fillRoundedRect(rgba, size, x, startY, barWidth, barHeight, barRadius, [42, 52, 68, 255]);

    const ratio = getBarFillRatio(provider);
    const color = getBarColor(provider, id);
    if (color && ratio > 0) {
      const fillH = Math.max(Math.max(2, Math.round(2 * scale)), Math.round(barHeight * ratio));
      const fillY = startY + (barHeight - fillH);
      fillRoundedRect(rgba, size, x, fillY, barWidth, fillH, barRadius, color);
    }
  }

  return encodePng(size, size, rgba);
}

/**
 * Generates a crisp 32x32 PNG buffer representing the 3 CLI meters (GPT, AGY, Claude).
 */
function createTrayIconPng(providers = {}) {
  return renderIconPngAtSize(providers, 32);
}

/**
 * Generates a real multi-resolution Windows .ico buffer (16x16, 32x32, 48x48 PNG-in-ICO)
 * for reliable Windows 11 Shell_NotifyIconW rendering.
 */
function createTrayIconIco(providers = {}) {
  const sizes = [16, 32, 48];
  const images = sizes.map((s) => ({ size: s, png: renderIconPngAtSize(providers, s) }));

  // ICONDIR (6 bytes) + ICONDIRENTRY (16 bytes * count)
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = ICO
  header.writeUInt16LE(images.length, 4);

  let offset = headerSize;
  for (let i = 0; i < images.length; i++) {
    const { size, png } = images[i];
    const entryOffset = 6 + i * 16;
    header[entryOffset] = size >= 256 ? 0 : size; // width
    header[entryOffset + 1] = size >= 256 ? 0 : size; // height
    header[entryOffset + 2] = 0; // palette count
    header[entryOffset + 3] = 0; // reserved
    header.writeUInt16LE(1, entryOffset + 4); // color planes
    header.writeUInt16LE(32, entryOffset + 6); // bits per pixel
    header.writeUInt32LE(png.length, entryOffset + 8); // bytes in resource
    header.writeUInt32LE(offset, entryOffset + 12); // image offset
    offset += png.length;
  }

  return Buffer.concat([header, ...images.map((im) => im.png)]);
}

module.exports = {
  createTrayIconPng,
  createTrayIconIco,
  computeTrayVisualKey,
  encodePng,
};
