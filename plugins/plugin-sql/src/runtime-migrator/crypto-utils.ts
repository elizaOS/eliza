/**
 * Browser-compatible crypto utilities
 * Uses the Web Crypto API which is available in both browsers and Node.js
 */

/**
 * Simple synchronous hash function for change detection
 * This is NOT cryptographic - it's just for comparing snapshots
 * Uses djb2 hash algorithm for speed and simplicity
 */
export function simpleHash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  // Convert to unsigned 32-bit integer and then to hex
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Create a longer hash by combining multiple passes
 * This provides better distribution for larger inputs
 */
export function extendedHash(str: string): string {
  // Run multiple passes with different seeds for better distribution
  const h1 = hashWithSeed(str, 5381);
  const h2 = hashWithSeed(str, 7919);
  const h3 = hashWithSeed(str, 104729);
  const h4 = hashWithSeed(str, 224737);

  return h1 + h2 + h3 + h4;
}

function hashWithSeed(str: string, seed: number): string {
  let hash = seed;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Convert string to Uint8Array
 */
function stringToBytes(str: string): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

/**
 * Convert ArrayBuffer to hex string
 */
function bufferToHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/**
 * Async SHA-256 hash using Web Crypto API
 * Works in both browsers and Node.js (v15+)
 */
export async function sha256Async(data: string): Promise<string> {
  const bytes = stringToBytes(data);
  // Cast to ArrayBuffer to satisfy TypeScript's strict BufferSource typing
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  return bufferToHex(hashBuffer);
}

/**
 * Generate a stable bigint from a string for advisory lock IDs
 * Uses a simple hash that produces consistent results across runs
 */
export function stringToBigInt(str: string): bigint {
  // Use extended hash for better uniqueness
  const hash = extendedHash(str);

  // Convert first 16 hex chars (64 bits) to bigint
  let lockId = BigInt(`0x${hash.slice(0, 16)}`);

  // Ensure the value fits in PostgreSQL's positive bigint range
  // Use a mask to keep only 63 bits (ensures positive in signed 64-bit)
  const mask63Bits = 0x7fffffffffffffffn;
  lockId = lockId & mask63Bits;

  // Ensure non-zero
  if (lockId === 0n) {
    lockId = 1n;
  }

  return lockId;
}
