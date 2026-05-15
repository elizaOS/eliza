/**
 * Local ASR (transcription) capability — public entry point.
 *
 * This module is what `provider.ts` (`createTranscriptionHandler`), the
 * voice pipeline bridge, and any future ASR consumer imports to register
 * the capability with the WS1 MemoryArbiter.
 *
 * Wiring:
 *
 *   const arbiter = service.getMemoryArbiter();
 *   const registration = createAsrCapabilityRegistration({
 *     loader: createDefaultAsrLoader({ ... }),
 *     transcriptCache: arbiter,
 *   });
 *   arbiter.registerCapability(registration);
 *
 * `createAsrCapabilityRegistration` wraps the underlying backend so the
 * arbiter's `run(request)` path:
 *
 *   1. Calls `backend.supports(request)`. If false, the arbiter throws
 *      `AsrBackendUnavailableError` with `unsupported_request`.
 *   2. Hashes the request's PCM bytes (sample-rate-normalized) and looks
 *      it up in the optional `transcriptCache`. On a hit, the backend is
 *      skipped entirely and the cached text is returned.
 *   3. On a miss, calls `backend.transcribe(request)`, stores the
 *      transcript under the same hash, and returns the result.
 *
 * The capability registers with `residentRole: "asr"` — distinct from the
 * `vision` slot that `vision-describe` and `image-gen` co-evict in.
 * Qwen-ASR cohabits comfortably with text on most desktops (≈600 MB for
 * Q4_K_M Qwen3-ASR-0.6B), but on a 6 GB iPhone / 8 GB low-tier Android
 * the arbiter's resident-role priority still lets a text-large request
 * evict the ASR handle when memory is tight. See `memory-arbiter.ts`
 * `RESIDENT_ROLE_PRIORITY`.
 */

export {
	AsrBackendUnavailableError,
	type AsrUnavailableReason,
	isAsrBackendUnavailable,
} from "./errors";
export { hashAsrInput } from "./hash";
export type {
	AsrBackend,
	AsrBackendLoader,
	AsrLoadArgs,
	AsrRequest,
	AsrResult,
} from "./types";

import type {
	ArbiterCapability,
	CapabilityRegistration,
} from "../memory-arbiter";
import { AsrBackendUnavailableError } from "./errors";
import { hashAsrInput } from "./hash";
import type {
	AsrBackend,
	AsrBackendLoader,
	AsrRequest,
	AsrResult,
} from "./types";

/**
 * Minimal cache shape the registration accepts. Lets tests inject a fake
 * cache without pulling in the whole MemoryArbiter. The arbiter
 * implements this surface (see `memory-arbiter.ts` `getCachedAsrTranscript`
 * / `setCachedAsrTranscript`).
 */
export interface AsrTranscriptCacheLike {
	getCachedAsrTranscript(hash: string): { text: string; live?: boolean } | null;
	setCachedAsrTranscript(
		hash: string,
		entry: { text: string },
		ttlMs?: number,
	): void;
}

export interface CreateAsrCapabilityRegistrationOptions {
	loader: AsrBackendLoader;
	/** Optional content-hash cache. When provided, identical PCM inputs skip the backend. */
	transcriptCache?: AsrTranscriptCacheLike;
	/** Default model family for the cache key. Defaults to `qwen3-asr`. */
	modelFamily?: string;
	/**
	 * Best-effort RAM footprint estimate for the loaded weights. The
	 * arbiter only uses this for telemetry; eviction is by priority. The
	 * default (600 MB) matches Q4_K_M Qwen3-ASR-0.6B; OpenVINO Whisper Large
	 * loaders SHOULD pass ~1500.
	 */
	estimatedMb?: number;
}

/**
 * Build a `CapabilityRegistration` ready to feed to
 * `arbiter.registerCapability()`. Mirrors `createVisionCapabilityRegistration`
 * (WS2) and `createImageGenCapabilityRegistration` (WS3).
 */
export function createAsrCapabilityRegistration(
	opts: CreateAsrCapabilityRegistrationOptions,
): CapabilityRegistration<AsrBackend, AsrRequest, AsrResult> {
	const capability: ArbiterCapability = "transcribe";
	const loader = opts.loader;
	const cache = opts.transcriptCache;
	const family = opts.modelFamily ?? "qwen3-asr";
	return {
		capability,
		// "asr" is its own resident-role slot in RESIDENT_ROLE_PRIORITY.
		// Qwen-ASR doesn't coexist in the same VRAM band as vision/image-gen
		// — the arbiter only evicts ASR when a higher-priority role
		// (text-target, text-drafter) needs the budget back.
		residentRole: "asr",
		estimatedMb: opts.estimatedMb ?? 600,
		async load(modelKey: string): Promise<AsrBackend> {
			return await loader(modelKey);
		},
		async unload(backend: AsrBackend): Promise<void> {
			await backend.dispose();
		},
		async run(backend: AsrBackend, request: AsrRequest): Promise<AsrResult> {
			if (!(request.pcm instanceof Float32Array) || request.pcm.length === 0) {
				throw new AsrBackendUnavailableError(
					backend.id,
					"unsupported_request",
					`[asr] backend "${backend.id}" requires non-empty Float32Array pcm`,
				);
			}
			if (!Number.isFinite(request.sampleRateHz) || request.sampleRateHz <= 0) {
				throw new AsrBackendUnavailableError(
					backend.id,
					"unsupported_request",
					`[asr] backend "${backend.id}" requires a positive sampleRateHz; got ${request.sampleRateHz}`,
				);
			}
			if (!backend.supports(request)) {
				throw new AsrBackendUnavailableError(
					backend.id,
					"unsupported_request",
					`[asr] backend "${backend.id}" does not support this request (sampleRateHz=${request.sampleRateHz} pcmSamples=${request.pcm.length})`,
				);
			}
			// Content-hash cache lookup. Honour `signal` between cache + backend.
			if (request.signal?.aborted) {
				throw request.signal.reason instanceof Error
					? request.signal.reason
					: new DOMException("Aborted", "AbortError");
			}
			let hash: string | null = null;
			if (cache) {
				try {
					hash = hashAsrInput(request, family);
					const hit = cache.getCachedAsrTranscript(hash);
					if (hit && hit.live !== false) {
						return { text: hit.text, cacheHit: true };
					}
				} catch {
					// Hashing failed (zero-length pcm guarded above; this catches
					// hash backend issues). Fall through to the backend.
					hash = null;
				}
			}
			const result = await backend.transcribe(request);
			if (request.signal?.aborted) {
				throw request.signal.reason instanceof Error
					? request.signal.reason
					: new DOMException("Aborted", "AbortError");
			}
			if (cache && hash) {
				try {
					cache.setCachedAsrTranscript(hash, { text: result.text });
				} catch {
					// Caching is best-effort; never let a cache write fail a request.
				}
			}
			return { ...result, cacheHit: false };
		},
	};
}
