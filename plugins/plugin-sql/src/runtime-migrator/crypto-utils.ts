/**
 * Browser-compatible crypto utilities
 * Uses the Web Crypto API which is available in both browsers and Node.js
 */

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
