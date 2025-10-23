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
 * Convert a hex string to a buffer-like object
 * @param hex - The hexadecimal string to convert
 * @returns A BufferLike object
 */
export declare function fromHex(hex: string): BufferLike;
/**
 * Convert a string to a buffer-like object
 * @param str - The string to convert
 * @param encoding - The encoding to use (default: 'utf8')
 * @returns A BufferLike object
 */
export declare function fromString(str: string, encoding?: 'utf8' | 'utf-8' | 'base64'): BufferLike;
/**
 * Convert a buffer-like object to a hexadecimal string
 * @param buffer - The buffer to convert
 * @returns A hexadecimal string
 */
export declare function toHex(buffer: BufferLike): string;
/**
 * Convert a buffer-like object to a string
 * @param buffer - The buffer to convert
 * @param encoding - The encoding to use (default: 'utf8')
 * @returns A string
 */
export declare function toString(buffer: BufferLike, encoding?: 'utf8' | 'utf-8' | 'base64' | 'hex'): string;
/**
 * Check if an object is a Buffer or buffer-like object
 * @param obj - The object to check
 * @returns True if the object is buffer-like
 */
export declare function isBuffer(obj: any): obj is BufferLike;
/**
 * Create a buffer of a specific size filled with zeros
 * @param size - The size of the buffer
 * @returns A BufferLike object
 */
export declare function alloc(size: number): BufferLike;
/**
 * Create a buffer from an array of bytes
 * @param bytes - Array of byte values
 * @returns A BufferLike object
 */
export declare function fromBytes(bytes: number[] | Uint8Array): BufferLike;
/**
 * Concatenate multiple buffers
 * @param buffers - Array of buffers to concatenate
 * @returns A new BufferLike object
 */
export declare function concat(buffers: BufferLike[]): BufferLike;
/**
 * Slice a buffer to create a new buffer
 * @param buffer - The buffer to slice
 * @param start - Start index
 * @param end - End index (optional)
 * @returns A new BufferLike object
 */
export declare function slice(buffer: BufferLike, start: number, end?: number): BufferLike;
/**
 * Compare two buffers for equality
 * @param a - First buffer
 * @param b - Second buffer
 * @returns True if buffers are equal
 */
export declare function equals(a: BufferLike, b: BufferLike): boolean;
/**
 * Get the byte length of a buffer
 * @param buffer - The buffer
 * @returns The byte length
 */
export declare function byteLength(buffer: BufferLike): number;
/**
 * Create a random buffer of specified size
 * @param size - The size of the buffer
 * @returns A BufferLike object filled with random bytes
 */
export declare function randomBytes(size: number): BufferLike;
export declare const BufferUtils: {
    fromHex: typeof fromHex;
    fromString: typeof fromString;
    fromBytes: typeof fromBytes;
    toHex: typeof toHex;
    toString: typeof toString;
    isBuffer: typeof isBuffer;
    alloc: typeof alloc;
    concat: typeof concat;
    slice: typeof slice;
    equals: typeof equals;
    byteLength: typeof byteLength;
    randomBytes: typeof randomBytes;
};
export type { BufferLike as Buffer };
//# sourceMappingURL=buffer.d.ts.map