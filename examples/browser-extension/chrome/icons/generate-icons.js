// Generate simple PNG icons for the extension
// Run with: bun run icons/generate-icons.js

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal PNG header + IHDR + IDAT + IEND chunks
// Creates a solid purple square icon

function createPNG(size) {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  
  // IHDR chunk
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(size, 0); // width
  ihdrData.writeUInt32BE(size, 4); // height
  ihdrData.writeUInt8(8, 8);  // bit depth
  ihdrData.writeUInt8(2, 9);  // color type (RGB)
  ihdrData.writeUInt8(0, 10); // compression
  ihdrData.writeUInt8(0, 11); // filter
  ihdrData.writeUInt8(0, 12); // interlace
  
  const ihdr = createChunk("IHDR", ihdrData);
  
  // Create raw pixel data (purple: RGB 99, 102, 241)
  const rawData = [];
  for (let y = 0; y < size; y++) {
    rawData.push(0); // filter byte
    for (let x = 0; x < size; x++) {
      rawData.push(99, 102, 241); // RGB
    }
  }
  
  // Compress with deflate (using Bun's built-in)
  const uncompressed = Buffer.from(rawData);
  const compressed = Bun.deflateSync(uncompressed);
  
  const idat = createChunk("IDAT", compressed);
  
  // IEND chunk
  const iend = createChunk("IEND", Buffer.alloc(0));
  
  return Buffer.concat([signature, ihdr, idat, iend]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  
  const typeBuffer = Buffer.from(type, "ascii");
  const dataBuffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  
  // Calculate CRC
  const crcData = Buffer.concat([typeBuffer, dataBuffer]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcData), 0);
  
  return Buffer.concat([length, typeBuffer, dataBuffer, crc]);
}

// CRC32 implementation
function crc32(data) {
  let crc = 0xFFFFFFFF;
  const table = getCRC32Table();
  
  for (let i = 0; i < data.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
  }
  
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

let crcTable;
function getCRC32Table() {
  if (crcTable) return crcTable;
  
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    crcTable[i] = c;
  }
  return crcTable;
}

// Generate icons
const sizes = [16, 48, 128];

for (const size of sizes) {
  const png = createPNG(size);
  const path = join(__dirname, `icon-${size}.png`);
  writeFileSync(path, png);
  console.log(`Created ${path} (${png.length} bytes)`);
}

console.log("Done!");
