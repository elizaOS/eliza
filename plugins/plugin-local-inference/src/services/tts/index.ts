/**
 * Local text-to-speech capability (WS5) — public entry point.
 *
 * This module is what `provider.ts` (`createTextToSpeechHandler`), the
 * voice lifecycle service, and any future TTS skill imports to register
 * the capability with the WS1 `MemoryArbiter`.
 *
 * Wiring:
 *
 *   const arbiter = service.getMemoryArbiter();
 *   const registration = createTtsCapabilityRegistration({
 *     loader: createDefaultTtsLoader({ ... }),
 *     cache: arbiterTtsCache,
 *   });
 *   arbiter.registerCapability(registration);
 *
 * `createTtsCapabilityRegistration` wraps the underlying backend so the
 * arbiter's `run(request)` path:
 *
 *   1. Hashes the request (`hashTtsRequest`) against the loaded model id.
 *   2. Checks the capability-level audio cache (`tts-audio` namespace).
 *      On hit it short-circuits the backend and returns the cached bytes
 *      with `metadata.cacheHit = true`.
 *   3. On miss: calls `backend.supports(request)`. If false the arbiter
 *      throws `TtsBackendUnavailableError` with `unsupported_request` so
 *      the runtime model registry can fall through to the next provider
 *      in priority order (typically `plugin-edge-tts` as the cloud
 *      fallback). No silent fallback inside the capability — the runtime
 *      owns provider-cascade routing, AGENTS.md §3.
 *   4. Calls `backend.synthesize(request)`, populates the cache, and
 *      returns the result.
 *
 * The capability registers with the default `"tts"` resident role
 * (`memory-arbiter.ts#CAPABILITY_ROLE.speak === "tts"`). Co-evicts with
 * NOTHING in particular — TTS has its own role in the `RESIDENT_ROLE_PRIORITY`
 * table and is the first non-text bucket the arbiter drops under critical
 * pressure. That ordering is deliberate: voice output is the cheapest
 * audible feature to defer; vision/image-gen weights take longer to
 * re-load.
 */

export { TtsBackendUnavailableError, isTtsUnavailable } from "./errors";
export type {
	TtsBackend,
	TtsBackendLoader,
	TtsLoadArgs,
	TtsMimeType,
	TtsRequest,
	TtsResult,
} from "./types";
export {
	hashTtsRequest,
	TtsAudioCache,
	type TtsAudioCacheConfig,
	type TtsAudioEntry,
} from "./tts-audio-cache";

import type {
	ArbiterCapability,
	CapabilityRegistration,
} from "../memory-arbiter";
import { TtsBackendUnavailableError } from "./errors";
import {
	hashTtsRequest,
	type TtsAudioCache,
	type TtsAudioEntry,
} from "./tts-audio-cache";
import type {
	TtsBackend,
	TtsBackendLoader,
	TtsMimeType,
	TtsRequest,
	TtsResult,
} from "./types";

/**
 * Minimal cache shape the registration needs. Lets tests inject a fake
 * cache without instantiating the full `TtsAudioCache`.
 */
export interface TtsAudioCacheLike {
	get(hash: string): TtsAudioEntry | null;
	set(
		hash: string,
		entry: {
			audio: Uint8Array;
			mime: TtsMimeType;
			sampleRate: number;
			voice: string;
			model: string;
		},
		ttlMs?: number,
	): void;
}

export interface CreateTtsCapabilityRegistrationOptions {
	loader: TtsBackendLoader;
	/**
	 * Optional audio cache. When provided the wrapper performs hash →
	 * cache lookup before calling the backend's `synthesize`. The cache
	 * is keyed on `(provider, model, voice, text, speed, sampleRate)` via
	 * {@link hashTtsRequest}; the provider name is fixed to
	 * `"eliza-local-inference"` so cache entries don't collide with a
	 * different runtime's TTS cache living in the same process.
	 */
	cache?: TtsAudioCacheLike;
	/**
	 * Default provider name used in the cache key. Defaults to
	 * `"eliza-local-inference"`. Tests may override to assert keying.
	 */
	provider?: string;
	/**
	 * Best-effort RAM footprint estimate for the loaded weights. The
	 * arbiter only uses this for telemetry; eviction is by priority.
	 * Defaults: Kokoro ≈ 350 MB int8 / 410 MB fp32; OmniVoice ranges
	 * 800–1700 MB across the Q3..Q8 ladder. The right call site is
	 * `loader.estimatedMb` once it's resolved against the active tier.
	 */
	estimatedMb?: number;
	/**
	 * Optional override for the cache TTL on insert. Defaults to the
	 * `TtsAudioCache` default (10 min).
	 */
	cacheTtlMs?: number;
}

/**
 * Build a `CapabilityRegistration` ready to feed to
 * `arbiter.registerCapability()`. Mirrors
 * `createVisionCapabilityRegistration` from WS2 and
 * `createImageGenCapabilityRegistration` from WS3.
 */
export function createTtsCapabilityRegistration(
	opts: CreateTtsCapabilityRegistrationOptions,
): CapabilityRegistration<TtsBackend, TtsRequest, TtsResult> {
	const capability: ArbiterCapability = "speak";
	const loader = opts.loader;
	const cache = opts.cache;
	const provider = opts.provider ?? "eliza-local-inference";
	const cacheTtlMs = opts.cacheTtlMs;
	return {
		capability,
		estimatedMb: opts.estimatedMb ?? 600,
		async load(modelKey: string): Promise<TtsBackend> {
			return await loader(modelKey);
		},
		async unload(backend: TtsBackend): Promise<void> {
			await backend.dispose();
		},
		async run(
			backend: TtsBackend,
			request: TtsRequest,
		): Promise<TtsResult> {
			// 1. Reject unsupported requests cleanly — no silent fallback.
			if (!backend.supports(request)) {
				throw new TtsBackendUnavailableError(
					backend.id,
					"unsupported_request",
					`[tts] backend "${backend.id}" does not support this request (voice=${request.voice ?? "default"} sampleRate=${request.sampleRate ?? "native"})`,
				);
			}

			// 2. Cache lookup (if a cache is wired).
			let cacheKey: string | null = null;
			if (cache) {
				cacheKey = hashTtsRequest({
					provider,
					model: backend.id,
					voice: request.voice ?? "default",
					text: request.text,
					...(typeof request.speed === "number"
						? { speed: request.speed }
						: {}),
					...(typeof request.sampleRate === "number"
						? { sampleRate: request.sampleRate }
						: {}),
				});
				const hit = cache.get(cacheKey);
				if (hit && hit.live !== false) {
					return {
						audio: hit.audio,
						mime: hit.mime,
						sampleRate: hit.sampleRate,
						metadata: {
							model: hit.model,
							voice: hit.voice,
							text: request.text,
							inferenceTimeMs: 0,
							cacheHit: true,
						},
					};
				}
			}

			// 3. Miss — synthesize through the backend.
			const result = await backend.synthesize(request);

			// 4. Populate cache (best-effort).
			if (cache && cacheKey) {
				cache.set(
					cacheKey,
					{
						audio: result.audio,
						mime: result.mime,
						sampleRate: result.sampleRate,
						voice: result.metadata.voice,
						model: result.metadata.model,
					},
					cacheTtlMs,
				);
			}

			return {
				...result,
				metadata: {
					...result.metadata,
					cacheHit: false,
				},
			};
		},
	};
}
