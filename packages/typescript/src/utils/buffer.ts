/**
 * Browser and Node.js compatible buffer abstraction
 * This module provides a cross-platform interface for buffer operations
 * that works in both browser and Node.js environments.
 *
 * In browsers, we use Uint8Array as a Buffer replacement.
 * In Node.js, we use the native Buffer.
 */

/**
 * Type representing a buffer-like object that works in both environments
 */
export type BufferLike = Buffer | Uint8Array;

/**
 * Check if we're in a Node.js environment with Buffer support
 */
function hasNativeBuffer(): boolean {
  return typeof Buffer !== "undefined" && typeof Buffer.from === "function";
}

/**
 * Convert a hex string to a buffer-like object
 * @param hex - The hexadecimal string to convert
 * @returns A BufferLike object
 */
export function fromHex(hex: string): BufferLike {
  // Clean the hex string to remove non-hex characters
  const cleanHex = hex.replace(/[^0-9a-fA-F]/g, "");

  if (hasNativeBuffer()) {
    return Buffer.from(cleanHex, "hex");
  }

  // Browser implementation using Uint8Array
  const bytes = new Uint8Array(cleanHex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(cleanHex.substr(i * 2, 2), 16);
  }
  return bytes;
}

/**
 * Convert a string to a buffer-like object
 * @param str - The string to convert
 * @param encoding - The encoding to use (default: 'utf8')
 * @returns A BufferLike object
 */
export function fromString(
  str: string,
  encoding: "utf8" | "utf-8" | "base64" = "utf8",
): BufferLike {
  if (hasNativeBuffer()) {
    const enc = encoding === "utf-8" ? "utf8" : encoding;
    return Buffer.from(str, enc as BufferEncoding);
  }

  // Browser implementation
  if (encoding === "base64") {
    const binaryString = atob(str);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  // UTF-8 encoding using TextEncoder (standard browser API)
  return new TextEncoder().encode(str);
}

/**
 * Convert a buffer-like object to a hexadecimal string
 * @param buffer - The buffer to convert
 * @returns A hexadecimal string
 */
export function toHex(buffer: BufferLike): string {
  if (hasNativeBuffer() && Buffer.isBuffer(buffer)) {
    return buffer.toString("hex");
  }

  // Browser implementation - buffer is already Uint8Array compatible
  const hexParts = new Array<string>(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i].toString(16);
    hexParts[i] = byte.length === 1 ? `0${byte}` : byte;
  }
  return hexParts.join("");
}

/**
 * Convert a buffer-like object to a string
 * @param buffer - The buffer to convert
 * @param encoding - The encoding to use (default: 'utf8')
 * @returns A string
 */
export function bufferToString(
  buffer: BufferLike,
  encoding: "utf8" | "utf-8" | "base64" | "hex" = "utf8",
): string {
  if (hasNativeBuffer() && Buffer.isBuffer(buffer)) {
    const enc = encoding === "utf-8" ? "utf8" : encoding;
    return buffer.toString(enc as BufferEncoding);
  }

  if (encoding === "hex") {
    return toHex(buffer);
  }

  if (encoding === "base64") {
    const chars = new Array<string>(buffer.length);
    for (let i = 0; i < buffer.length; i++) {
      chars[i] = String.fromCharCode(buffer[i]);
    }
    return btoa(chars.join(""));
  }

  // UTF-8 decoding using TextDecoder (standard browser API)
  return new TextDecoder().decode(buffer);
}

/**
 * Check if an object is a Buffer or Uint8Array
 * @param obj - The object to check
 * @returns True if the object is buffer-like
 */
export function isBuffer(obj: unknown): obj is BufferLike {
  if (obj === null || obj === undefined) {
    return false;
  }

  // Check for Node.js Buffer
  if (hasNativeBuffer() && Buffer.isBuffer(obj)) {
    return true;
  }

  // Check for Uint8Array (includes Buffer since Buffer extends Uint8Array)
  return obj instanceof Uint8Array;
}

/**
 * Create a buffer of a specific size filled with zeros
 * @param size - The size of the buffer
 * @returns A BufferLike object
 */
export function alloc(size: number): BufferLike {
  if (hasNativeBuffer()) {
    return Buffer.alloc(size);
  }
  return new Uint8Array(size);
}

/**
 * Create a buffer from an array of bytes
 * @param bytes - Array of byte values
 * @returns A BufferLike object
 */
export function fromBytes(bytes: number[] | Uint8Array): BufferLike {
  if (hasNativeBuffer()) {
    return Buffer.from(bytes);
  }
  return new Uint8Array(bytes);
}

/**
 * Concatenate multiple buffers
 * @param buffers - Array of buffers to concatenate
 * @returns A new BufferLike object
 */
export function concat(buffers: BufferLike[]): BufferLike {
  if (hasNativeBuffer() && buffers.every((b) => Buffer.isBuffer(b))) {
    return Buffer.concat(buffers as Buffer[]);
  }

  // Calculate total length
  let totalLength = 0;
  for (const buffer of buffers) {
    totalLength += buffer.length;
  }

  // Create result buffer and copy data
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buffer of buffers) {
    result.set(buffer, offset);
    offset += buffer.length;
  }

  return result;
}

/**
 * Slice a buffer to create a new buffer
 * @param buffer - The buffer to slice
 * @param start - Start index
 * @param end - End index (optional)
 * @returns A new BufferLike object
 */
export function slice(
  buffer: BufferLike,
  start: number,
  end?: number,
): BufferLike {
  if (hasNativeBuffer() && Buffer.isBuffer(buffer)) {
    return buffer.slice(start, end);
  }
  return buffer.slice(start, end);
}

/**
 * Compare two buffers for equality
 * @param a - First buffer
 * @param b - Second buffer
 * @returns True if buffers are equal
 */
export function equals(a: BufferLike, b: BufferLike): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }

  return true;
}

/**
 * Get the byte length of a buffer
 * @param buffer - The buffer
 * @returns The byte length
 */
export function byteLength(buffer: BufferLike): number {
  return buffer.length;
}

/**
 * Create a random buffer of specified size using cryptographically secure random bytes.
 * @param size - The size of the buffer
 * @returns A BufferLike object filled with random bytes
 * @throws Error if no cryptographic random source is available
 */
export function randomBytes(size: number): BufferLike {
  const bytes = new Uint8Array(size);

  // Use globalThis.crypto which is available in modern Node.js (>=18) and all browsers
  const cryptoObj = globalThis.crypto;

  if (cryptoObj && typeof cryptoObj.getRandomValues === "function") {
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }

  // No secure random source available - throw instead of using insecure fallback
  throw new Error(
    "No cryptographically secure random source available. " +
      "Ensure you are running in a modern browser or Node.js >= 18.",
  );
}

// Export a namespace-like object for compatibility
export const BufferUtils = {
  fromHex,
  fromString,
  fromBytes,
  toHex,
  bufferToString,
  toString: bufferToString,
  isBuffer,
  alloc,
  concat,
  slice,
  equals,
  byteLength,
  randomBytes,
};

// Export type for use in other modules
export type { BufferLike as Buffer };
