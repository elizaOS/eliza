/**
 * Content-hash keys for the ASR transcript cache.
 *
 * The arbiter caches `AsrResult.text` by the SHA-256 of the
 * sample-rate-normalized PCM bytes. The hash is fast (one pass over the
 * fp32 buffer + a 4-byte sample-rate prefix) and stable across runs, so a
 * caller who re-issues the same WAV gets the cached transcript without
 * re-running the backend.
 *
 * We hash the underlying byte view of the Float32Array, not a re-quantized
 * representation, so caller-supplied PCM that came from a 16-bit WAV
 * decode (the common case from the `runtime.useModel(TRANSCRIPTION, ...)`
 * path) deduplicates correctly with caller-supplied PCM that came from a
 * fp32 mic capture.
 */

import { createHash } from "node:crypto";

import type { AsrRequest } from "./types";

/** Family namespace prepended to every hash so caches scoped to different ASR families don't collide. */
const HASH_FAMILY_DEFAULT = "qwen3-asr";

/**
 * Hash a PCM buffer + sample rate into a stable cache key. The output is
 * `<modelFamily>::sha256(<sampleRateLE><pcmBytes>)`.
 *
 * - `sampleRateLE`: 4-byte little-endian uint32 prefix so 16 kHz / 24 kHz
 *   inputs of the same float samples produce different keys.
 * - `pcmBytes`: the raw fp32 view (`pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)`).
 *
 * Returns the hex digest namespaced by family.
 */
export function hashAsrInput(req: AsrRequest, family?: string): string {
	const hasher = createHash("sha256");
	const rateBuf = new ArrayBuffer(4);
	new DataView(rateBuf).setUint32(0, Math.max(0, Math.floor(req.sampleRateHz)), true);
	hasher.update(new Uint8Array(rateBuf));
	const pcm = req.pcm;
	const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
	hasher.update(bytes);
	if (req.language) hasher.update(`lang:${req.language}`);
	const fam = req.modelFamily ?? family ?? HASH_FAMILY_DEFAULT;
	return `${fam}::${hasher.digest("hex")}`;
}
