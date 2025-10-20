/**
 * Browser and Node.js compatible buffer abstraction
 * This module provides a unified interface for buffer operations
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
  return typeof Buffer !== 'undefined' && typeof Buffer.from === 'function';
}

/**
 * Convert a hex string to a buffer-like object
 * @param hex - The hexadecimal string to convert
 * @returns A BufferLike object
 */
export function fromHex(hex: string): BufferLike {
  // Clean the hex string to remove non-hex characters
  const cleanHex = hex.replace(/[^0-9a-fA-F]/g, '');

  if (hasNativeBuffer()) {
    // Use native Buffer in Node.js
    return Buffer.from(cleanHex, 'hex');
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
  encoding: 'utf8' | 'utf-8' | 'base64' = 'utf8'
): BufferLike {
  if (hasNativeBuffer()) {
    // Use native Buffer in Node.js
    const enc = encoding === 'utf-8' ? 'utf8' : encoding;
    return Buffer.from(str, enc as BufferEncoding);
  }

  // Browser implementation
  if (encoding === 'base64') {
    // Decode base64 string
    const binaryString = atob(str);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  // UTF-8 encoding using TextEncoder (standard browser API)
  const encoder = new TextEncoder();
  return encoder.encode(str);
}

/**
 * Convert a buffer-like object to a hexadecimal string
 * @param buffer - The buffer to convert
 * @returns A hexadecimal string
 */
export function toHex(buffer: BufferLike): string {
  if (hasNativeBuffer() && Buffer.isBuffer(buffer)) {
    // Use native Buffer method in Node.js
    return buffer.toString('hex');
  }

  // Browser implementation
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i].toString(16);
    hex += byte.length === 1 ? '0' + byte : byte;
  }
  return hex;
}

/**
 * Convert a buffer-like object to a string
 * @param buffer - The buffer to convert
 * @param encoding - The encoding to use (default: 'utf8')
 * @returns A string
 */
export function toString(
  buffer: BufferLike,
  encoding: 'utf8' | 'utf-8' | 'base64' | 'hex' = 'utf8'
): string {
  if (hasNativeBuffer() && Buffer.isBuffer(buffer)) {
    // Use native Buffer method in Node.js
    const enc = encoding === 'utf-8' ? 'utf8' : encoding;
    return buffer.toString(enc as BufferEncoding);
  }

  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);

  // Handle different encodings
  if (encoding === 'hex') {
    return toHex(bytes);
  }

  if (encoding === 'base64') {
    // Convert to base64
    let binaryString = '';
    for (let i = 0; i < bytes.length; i++) {
      binaryString += String.fromCharCode(bytes[i]);
    }
    return btoa(binaryString);
  }

  // UTF-8 decoding using TextDecoder (standard browser API)
  const decoder = new TextDecoder();
  return decoder.decode(bytes);
}

/**
 * Check if an object is a Buffer or buffer-like object
 * @param obj - The object to check
 * @returns True if the object is buffer-like
 */
export function isBuffer(obj: any): obj is BufferLike {
  if (!obj) {
    return false;
  }

  if (hasNativeBuffer() && Buffer.isBuffer(obj)) {
    return true;
  }

  // Check for Uint8Array or similar typed arrays
  return (
    obj instanceof Uint8Array ||
    obj instanceof ArrayBuffer ||
    (typeof obj === 'object' &&
      obj.buffer instanceof ArrayBuffer &&
      typeof obj.byteLength === 'number' &&
      !Array.isArray(obj))
  );
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

  // Create result buffer
  const result = new Uint8Array(totalLength);
  let offset = 0;

  for (const buffer of buffers) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    result.set(bytes, offset);
    offset += bytes.length;
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
export function slice(buffer: BufferLike, start: number, end?: number): BufferLike {
  if (hasNativeBuffer() && Buffer.isBuffer(buffer)) {
    return buffer.slice(start, end);
  }

  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return bytes.slice(start, end);
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

  const bytesA = a instanceof Uint8Array ? a : new Uint8Array(a);
  const bytesB = b instanceof Uint8Array ? b : new Uint8Array(b);

  for (let i = 0; i < bytesA.length; i++) {
    if (bytesA[i] !== bytesB[i]) {
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
 * Create a random buffer of specified size
 * @param size - The size of the buffer
 * @returns A BufferLike object filled with random bytes
 */
export function randomBytes(size: number): BufferLike {
  // Prefer Web Crypto API across environments (Node >=18 exposes global crypto)
  const bytes = new Uint8Array(size);

  const cryptoGlobal: any =
    typeof globalThis !== 'undefined'
      ? (globalThis as any).crypto || (globalThis as any).webcrypto
      : undefined;

  if (cryptoGlobal && typeof cryptoGlobal.getRandomValues === 'function') {
    cryptoGlobal.getRandomValues(bytes);
  } else {
    // Fallback: less secure random generation
    for (let i = 0; i < size; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  return bytes;
}

// Export a namespace-like object for compatibility
export const BufferUtils = {
  fromHex,
  fromString,
  fromBytes,
  toHex,
  toString,
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
