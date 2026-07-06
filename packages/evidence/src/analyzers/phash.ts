/**
 * `hash.perceptual` — a 64-bit DCT perceptual hash for tracking screen identity
 * across runs. The classic pHash: reduce to 32×32 grayscale, take the 2-D DCT,
 * keep the top-left 8×8 low-frequency block (excluding the DC term), and set
 * each bit by whether its coefficient exceeds the block median. Implemented
 * directly on sharp raw grayscale (~40 deterministic lines) rather than pulling
 * in `sharp-phash`, so there is no new dependency and the algorithm is
 * inspectable and testable. Hamming distance between two hashes measures visual
 * similarity: identical renders hash to distance 0, a small crop stays small,
 * and different screens diverge — the "same screen ≤ threshold" util keys
 * stability tracking on that.
 */

import sharp from "sharp";
import type { Analyzer, AnalyzerFragment, AnalyzerInput } from "./types.ts";

const DCT_SIZE = 32;
const HASH_SIZE = 8;

/** Precomputed DCT-II basis: cos((2x+1)·u·π / 2N) for the 32-wide transform. */
const DCT_BASIS = buildDctBasis(DCT_SIZE);

/** Payload of a `ran` `hash.perceptual` result. */
export interface PerceptualHashData {
  /** 16-hex-char (64-bit) perceptual hash. */
  phash: string;
}

/**
 * Compute the 64-bit DCT pHash of an image as a 16-char hex string. Grayscale
 * reduction and the fixed 32→8 pipeline make the hash resolution-independent.
 */
export async function perceptualHash(imagePath: string): Promise<string> {
  const { data } = await sharp(imagePath)
    .resize(DCT_SIZE, DCT_SIZE, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Single-channel after grayscale; read one byte per pixel.
  const pixels = new Float64Array(DCT_SIZE * DCT_SIZE);
  for (let i = 0; i < pixels.length; i++) pixels[i] = data[i];
  const dct = dct2d(pixels, DCT_SIZE);

  // Top-left 8×8 low-frequency block, DC term (0,0) excluded from the median.
  const block: number[] = [];
  for (let u = 0; u < HASH_SIZE; u++) {
    for (let v = 0; v < HASH_SIZE; v++) {
      block.push(dct[u * DCT_SIZE + v]);
    }
  }
  const median = medianOf(block.slice(1));

  let bits = 0n;
  for (let i = 0; i < block.length; i++) {
    bits <<= 1n;
    if (block[i] > median) bits |= 1n;
  }
  return bits.toString(16).padStart((HASH_SIZE * HASH_SIZE) / 4, "0");
}

/** Hamming distance between two hex pHashes (count of differing bits). */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    throw new Error(`phash length mismatch: ${a.length} vs ${b.length}`);
  }
  let xor = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let distance = 0;
  while (xor > 0n) {
    distance += Number(xor & 1n);
    xor >>= 1n;
  }
  return distance;
}

/** Default same-screen threshold: ≤8 differing bits reads as the same screen. */
export const SAME_SCREEN_THRESHOLD = 8;

/** Whether two pHashes are within the same-screen Hamming threshold. */
export function isSameScreen(
  a: string,
  b: string,
  threshold = SAME_SCREEN_THRESHOLD,
): boolean {
  return hammingDistance(a, b) <= threshold;
}

export const perceptualHashAnalyzer: Analyzer = {
  name: "hash.perceptual",
  tier: "cpu",
  kinds: ["screenshot", "keyframe"],
  async analyze(input: AnalyzerInput): Promise<AnalyzerFragment> {
    const phash = await perceptualHash(input.absolutePath);
    const data: PerceptualHashData = { phash };
    return { status: "ran", data };
  },
};

/** Separable 2-D DCT-II: rows then columns, reusing the precomputed basis. */
function dct2d(pixels: Float64Array, n: number): Float64Array {
  const rows = new Float64Array(n * n);
  // DCT along each row.
  for (let y = 0; y < n; y++) {
    for (let u = 0; u < n; u++) {
      let sum = 0;
      for (let x = 0; x < n; x++) {
        sum += pixels[y * n + x] * DCT_BASIS[u * n + x];
      }
      rows[y * n + u] = sum;
    }
  }
  // DCT along each column.
  const out = new Float64Array(n * n);
  for (let x = 0; x < n; x++) {
    for (let u = 0; u < n; u++) {
      let sum = 0;
      for (let y = 0; y < n; y++) {
        sum += rows[y * n + x] * DCT_BASIS[u * n + y];
      }
      out[u * n + x] = sum;
    }
  }
  return out;
}

function buildDctBasis(n: number): Float64Array {
  const basis = new Float64Array(n * n);
  for (let u = 0; u < n; u++) {
    for (let x = 0; x < n; x++) {
      basis[u * n + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n));
    }
  }
  return basis;
}

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}
