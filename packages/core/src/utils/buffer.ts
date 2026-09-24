/**
 * Byte encoding and allocation for Node and Bun. Inputs accept Buffer and
 * Uint8Array so callers can pass binary protocol values without conversion.
 */
import { Buffer as NodeBuffer } from "node:buffer";
import { randomBytes as nodeRandomBytes } from "node:crypto";

export type BufferLike = NodeBuffer | Uint8Array;

/** Decode hexadecimal text, ignoring non-hex separators. */
export function fromHex(hex: string): BufferLike {
	return NodeBuffer.from(hex.replace(/[^0-9a-fA-F]/g, ""), "hex");
}

export function fromString(
	str: string,
	encoding: "utf8" | "utf-8" | "base64" = "utf8",
): BufferLike {
	return NodeBuffer.from(str, encoding);
}

export function toHex(buffer: BufferLike): string {
	return NodeBuffer.from(buffer).toString("hex");
}

export function bufferToString(
	buffer: BufferLike,
	encoding: "utf8" | "utf-8" | "base64" | "hex" = "utf8",
): string {
	return NodeBuffer.from(buffer).toString(encoding);
}

export function isBuffer(obj: unknown): obj is BufferLike {
	return NodeBuffer.isBuffer(obj) || obj instanceof Uint8Array;
}

export function alloc(size: number): BufferLike {
	return NodeBuffer.alloc(size);
}

export function fromBytes(bytes: number[] | Uint8Array): BufferLike {
	return NodeBuffer.from(bytes);
}

export function concat(buffers: BufferLike[]): BufferLike {
	return NodeBuffer.concat(buffers);
}

/** Preserve the input representation's slice ownership semantics. */
export function slice(
	buffer: BufferLike,
	start: number,
	end?: number,
): BufferLike {
	return buffer.slice(start, end);
}

export function equals(a: BufferLike, b: BufferLike): boolean {
	return NodeBuffer.compare(a, b) === 0;
}

export function byteLength(buffer: BufferLike): number {
	return buffer.length;
}

/** Allocate cryptographically secure random bytes using the runtime provider. */
export function randomBytes(size: number): BufferLike {
	return nodeRandomBytes(size);
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
