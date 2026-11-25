// spec/computerUse/observation.md, "Story: Minimize vision tokens while keeping coordinates and history strictly bounded"
import { deflateSync } from "node:zlib"
import { base64ToBytes, bytesToBase64, makeTempFilePath } from "../../src/platform-native.ts"

export { base64ToBytes, bytesToBase64, makeTempFilePath }

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] ?? 0
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length, false)
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  const crcInput = out.subarray(4, 8 + data.length)
  view.setUint32(8 + data.length, crc32(crcInput), false)
  return out
}

export function makeTestPngBase64(width: number, height: number, pattern: "gradient" | "checker"): string {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = new Uint8Array(13)
  const ihdrView = new DataView(ihdr.buffer)
  ihdrView.setUint32(0, width, false)
  ihdrView.setUint32(4, height, false)
  ihdr[8] = 8
  ihdr[9] = 2
  const stride = width * 3
  const raw = new Uint8Array(height * (stride + 1))
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    for (let x = 0; x < width; x += 1) {
      const idx = y * (stride + 1) + 1 + x * 3
      if (pattern === "gradient") {
        raw[idx] = Math.floor((x * 255) / Math.max(1, width - 1))
        raw[idx + 1] = Math.floor((y * 255) / Math.max(1, height - 1))
        raw[idx + 2] = 64
      } else {
        const on = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2) === 0
        raw[idx] = on ? 240 : 15
        raw[idx + 1] = on ? 240 : 15
        raw[idx + 2] = on ? 240 : 15
      }
    }
  }
  const idat = pngChunk("IDAT", new Uint8Array(deflateSync(raw)))
  const iend = pngChunk("IEND", new Uint8Array(0))
  const ihdrChunk = pngChunk("IHDR", ihdr)
  const combined = new Uint8Array(sig.length + ihdrChunk.length + idat.length + iend.length)
  combined.set(sig, 0)
  combined.set(ihdrChunk, sig.length)
  combined.set(idat, sig.length + ihdrChunk.length)
  combined.set(iend, sig.length + ihdrChunk.length + idat.length)
  return bytesToBase64(combined)
}
