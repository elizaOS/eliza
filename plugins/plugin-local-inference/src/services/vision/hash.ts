/**
 * Vision-embedding cache key derivation (WS2).
 *
 * The arbiter's vision-embedding cache (WS1, `vision-embedding-cache.ts`)
 * is keyed by SHA-256 of a *normalized* representation of the input
 * image. The normalization step is what makes the cache useful across
 * platforms: two JPEG encodings of the same screenshot, or an RGBA vs
 * RGB frame captured by different platforms, must hash to the same key
 * or the cache hit rate collapses.
 *
 * Normalization is deliberately minimal:
 *
 *   1. Resolve the input to raw bytes (decoding base64/data-url wrappers).
 *   2. Hash with the model-family prefix so the cache can hold tokens
 *      for multiple VL families without collision.
 *
 * What we DO NOT do here:
 *
 *   - Resize the image. The backend's projector enforces its own input
 *     resolution; the bytes the projector sees are what gets projected.
 *      Re-encoding here would add work without changing the hit rate
 *      (the platform-provided buffer is already at the camera's native
 *      resolution).
 *   - Strip JPEG/PNG headers. They contribute to the hash; two
 *      reencodings of the same pixel array land in different cache
 *      slots intentionally. Reuse only the exact same byte stream.
 *
 * If a downstream caller wants finer-grained cache hits (e.g. dedupe
 * across re-encodings of the same screen frame), it should decode to
 * RGBA pixels itself and call `hashRawPixels`. The default
 * `hashVisionInput` path is the conservative, byte-stream-only path.
 */

import { createHash } from "node:crypto";
import type { VisionImageInput } from "./types";

const DEFAULT_FAMILY = "qwen3-vl";

/**
 * Resolve a `VisionImageInput` to its raw bytes. Returns the decoded
 * payload plus an optional MIME type the caller can forward to the
 * backend. Throws on `url:` inputs — those must be fetched by the
 * caller; the hash step does not own HTTP.
 */
export function resolveImageBytes(
	input: VisionImageInput,
): { bytes: Uint8Array; mimeType?: string } {
	switch (input.kind) {
		case "bytes":
			return { bytes: input.bytes, mimeType: input.mimeType };
		case "base64": {
			const bytes = Uint8Array.from(Buffer.from(input.base64, "base64"));
			return { bytes, mimeType: input.mimeType };
		}
		case "dataUrl": {
			const match = /^data:([^;,]+)(?:;[^,]*)?,(.*)$/s.exec(input.dataUrl);
			if (!match) {
				throw new Error(
					"[vision/hash] malformed data URL — expected data:<mime>;base64,<payload>",
				);
			}
			const mimeType = match[1];
			const payload = match[2];
			const isBase64 = /;base64/i.test(input.dataUrl);
			const bytes = Uint8Array.from(
				Buffer.from(payload, isBase64 ? "base64" : "utf8"),
			);
			return { bytes, mimeType };
		}
		case "url":
			throw new Error(
				"[vision/hash] url inputs must be fetched by the caller before hashing — the hash step does not own HTTP",
			);
	}
}

/**
 * Hash an opaque byte stream with the model-family prefix. The result
 * is stable across processes and platforms (Node, Bun, and the
 * Capacitor JS bridge all return the same hex string for the same
 * input).
 */
export function hashImageBytes(
	bytes: Uint8Array,
	modelFamily: string = DEFAULT_FAMILY,
): string {
	const h = createHash("sha256");
	h.update(modelFamily);
	// Length prefix prevents a `family || bytes` collision against a
	// crafted family string that ends with the leading bytes of the
	// payload. Cheap, defensible.
	const lenBuf = Buffer.alloc(4);
	lenBuf.writeUInt32BE(bytes.byteLength, 0);
	h.update(lenBuf);
	h.update(bytes);
	return h.digest("hex");
}

/**
 * Hash a raw pixel buffer (RGBA / RGB / BGRA / BGR). The channel order
 * is folded into the prefix so the same image captured on two different
 * platforms (Android = RGBA, macOS screenshot = BGRA) produces the same
 * key when normalized. Width / height are also included so the cache
 * doesn't conflate two scaled versions of the same source.
 */
export function hashRawPixels(args: {
	bytes: Uint8Array;
	width: number;
	height: number;
	channelOrder: "rgba" | "rgb" | "bgra" | "bgr";
	modelFamily?: string;
}): string {
	const h = createHash("sha256");
	h.update(args.modelFamily ?? DEFAULT_FAMILY);
	h.update("|raw|");
	const prefix = Buffer.alloc(12);
	prefix.writeUInt32BE(args.width, 0);
	prefix.writeUInt32BE(args.height, 4);
	prefix.write(args.channelOrder.padEnd(4, " "), 8, "ascii");
	h.update(prefix);
	// Channel-order normalization: rewrite BGRA→RGBA and BGR→RGB in
	// place into a new buffer so all three platforms land on the same
	// hash even when the input buffer order differs.
	const normalized = normalizeChannels(args.bytes, args.channelOrder);
	h.update(normalized);
	return h.digest("hex");
}

function normalizeChannels(
	bytes: Uint8Array,
	order: "rgba" | "rgb" | "bgra" | "bgr",
): Uint8Array {
	if (order === "rgba" || order === "rgb") return bytes;
	const stride = order === "bgra" ? 4 : 3;
	const out = new Uint8Array(bytes.byteLength);
	for (let i = 0; i + stride <= bytes.byteLength; i += stride) {
		out[i] = bytes[i + 2];
		out[i + 1] = bytes[i + 1];
		out[i + 2] = bytes[i];
		if (stride === 4) out[i + 3] = bytes[i + 3];
	}
	return out;
}

/**
 * Convenience wrapper used by the provider: takes a `VisionImageInput`
 * and a model family, returns the cache key. URL inputs throw —
 * callers must fetch first.
 */
export function hashVisionInput(
	input: VisionImageInput,
	modelFamily: string = DEFAULT_FAMILY,
): string {
	const { bytes } = resolveImageBytes(input);
	return hashImageBytes(bytes, modelFamily);
}
