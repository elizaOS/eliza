/**
 * Minimal PNG encoder — produces a valid solid-color PNG of arbitrary
 * dimensions without any third-party dependency. Used by the pump.fun launcher
 * when no token icon is provided so the form's mandatory image-upload step has
 * something to swallow.
 */

import { deflateSync } from "node:zlib";

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c ^= bytes[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

export function makeSolidPng(opts: {
  width: number;
  height: number;
  /** RGBA, 0-255 */
  rgba: [number, number, number, number];
}): Buffer {
  const { width, height, rgba } = opts;
  if (width <= 0 || height <= 0 || width > 8192 || height > 8192) {
    throw new Error("invalid dims");
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // 8-bit
  ihdr.writeUInt8(6, 9); // RGBA
  ihdr.writeUInt8(0, 10);
  ihdr.writeUInt8(0, 11);
  ihdr.writeUInt8(0, 12);
  // raw pixel data: each row preceded by filter byte (0)
  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0; // filter type none
    for (let x = 0; x < width; x++) {
      const off = y * rowBytes + 1 + x * 4;
      raw[off] = rgba[0]!;
      raw[off + 1] = rgba[1]!;
      raw[off + 2] = rgba[2]!;
      raw[off + 3] = rgba[3]!;
    }
  }
  const idat = deflateSync(raw);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", new Uint8Array(0)),
  ]);
}
