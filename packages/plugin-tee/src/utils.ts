import { createHash } from 'node:crypto';

/**
 * Converts a hexadecimal string to a Uint8Array.
 *
 * @param {string} hex - The hexadecimal string to convert.
 * @returns {Uint8Array} - The resulting Uint8Array.
 * @throws {Error} - If the input hex string is invalid.
 */
export function hexToUint8Array(hex: string) {
  const hexString = hex.trim().replace(/^0x/, '');
  if (!hexString) {
    throw new Error('Invalid hex string');
  }
  if (hexString.length % 2 !== 0) {
    throw new Error('Invalid hex string');
  }

  const array = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < hexString.length; i += 2) {
    const byte = Number.parseInt(hexString.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error('Invalid hex string');
    }
    array[i / 2] = byte;
  }
  return array;
}

// Function to calculate SHA-256 and return a Buffer (32 bytes)
/**
 * Calculates the SHA256 hash of the input string.
 *
 * @param {string} input - The input string to calculate the hash from.
 * @returns {Buffer} - The calculated SHA256 hash as a Buffer object.
 */
export function calculateSHA256(input: string): Buffer {
  const hash = createHash('sha256');
  hash.update(input);
  return hash.digest();
}
