/**
 * Vision-describe capability (WS2) — public entry point.
 *
 * This module is what plugin-vision (WS4), the IMAGE_DESCRIPTION
 * handler in `provider.ts`, and computer-use (WS9) import to register
 * vision capability with the WS1 MemoryArbiter.
 *
 * Wiring:
 *
 *   const arbiter = service.getMemoryArbiter();
 *   const registration = createVisionCapabilityRegistration({
 *     loader: createDefaultVisionLoader({ ... }),
 *     arbiterCache: arbiter,
 *   });
 *   arbiter.registerCapability(registration);
 *
 * `createVisionCapabilityRegistration` wraps the underlying backend so
 * the arbiter's `run(request)` path:
 *
 *   1. Hashes the request's image bytes (model-family-scoped).
 *   2. Checks the arbiter's vision-embedding cache.
 *   3. On miss: calls `backend.describe(request)`, lets the backend
 *      run its own projector + decoder. (Today we don't have a typed
 *      hook to extract the projected tokens after the backend runs;
 *      that wiring is planned for when the elizaOS fork's mtmd binding
 *      lands `getProjectedTokens()` on the handle.) The result is
 *      returned and the cache stays empty for this hash — the
 *      decoder text is what the caller wanted anyway.
 *   4. On hit: calls `backend.describe(request, { projectedTokens })`.
 *      Backends that support pre-projected token reuse skip the
 *      projector entirely. Backends that don't ignore the hint; the
 *      result is still correct but the projector cost is paid again.
 */

export {
	type AospLlamaMtmdBinding,
	type AospMtmdHandle,
	type LoadAospVisionBackendOptions,
	loadAospVisionBackend,
} from "./aosp-stub";

export {
	hashImageBytes,
	hashRawPixels,
	hashVisionInput,
	resolveImageBytes,
} from "./hash";
export {
	createLlamaServerVisionBackend,
	type LlamaServerVisionBackendOptions,
} from "./llama-server";
export {
	loadNodeLlamaCppVisionBackend,
	type NodeLlamaCppMtmdBinding,
	type NodeLlamaCppMtmdHandle,
	type NodeLlamaCppVisionBackendOptions,
	VisionBackendUnavailableError,
	type VisionManagerLike,
} from "./node-llama-cpp";
export type {
	VisionDescribeBackend,
	VisionDescribeBackendLoader,
	VisionDescribeBackendOptions,
	VisionDescribeLoadArgs,
	VisionDescribeRequest,
	VisionDescribeResult,
	VisionImageChannelOrder,
	VisionImageInput,
} from "./types";

import type {
	ArbiterCapability,
	CapabilityRegistration,
} from "../memory-arbiter";
import { hashVisionInput } from "./hash";
import type {
	VisionDescribeBackend,
	VisionDescribeBackendLoader,
	VisionDescribeRequest,
	VisionDescribeResult,
} from "./types";

/**
 * Minimal arbiter shape we need from the cache. Lets tests inject a
 * fake cache without pulling in the whole MemoryArbiter.
 */
export interface VisionEmbeddingCacheLike {
	getCachedVisionEmbedding(hash: string): {
		tokens: Float32Array;
		tokenCount: number;
		hiddenSize: number;
		live?: boolean;
	} | null;
	setCachedVisionEmbedding(
		hash: string,
		entry: {
			tokens: Float32Array;
			tokenCount: number;
			hiddenSize: number;
		},
		ttlMs?: number,
	): void;
}

export interface CreateVisionCapabilityRegistrationOptions {
	/**
	 * The arbiter (or any object with the cache passthroughs). When
	 * provided the wrapper performs hash → cache lookup before calling
	 * the backend's `describe`.
	 */
	arbiterCache?: VisionEmbeddingCacheLike;
	loader: VisionDescribeBackendLoader;
	/** Default model family for the cache key. Defaults to `qwen3-vl`. */
	modelFamily?: string;
	estimatedMb?: number;
}

/**
 * Build a `CapabilityRegistration` ready to feed to
 * `arbiter.registerCapability()`. The wrapper plumbs the cache hint
 * into the backend's describe call so backends that support
 * pre-projected tokens skip the projector.
 */
export function createVisionCapabilityRegistration(
	opts: CreateVisionCapabilityRegistrationOptions,
): CapabilityRegistration<
	VisionDescribeBackend,
	VisionDescribeRequest,
	VisionDescribeResult
> {
	const capability: ArbiterCapability = "vision-describe";
	const family = opts.modelFamily ?? "qwen3-vl";
	const cache = opts.arbiterCache;
	const loader = opts.loader;
	return {
		capability,
		residentRole: "vision",
		estimatedMb: opts.estimatedMb ?? 600,
		async load(modelKey) {
			return await loader(modelKey);
		},
		async unload(backend) {
			await backend.dispose();
		},
		async run(backend, request) {
			const effectiveFamily = request.modelFamily ?? family;
			const cached = (() => {
				if (!cache) return null;
				if (request.image.kind === "url") {
					// URL inputs can't be hashed without first fetching; skip
					// the cache lookup rather than paying the fetch cost twice.
					return null;
				}
				try {
					const hash = hashVisionInput(request.image, effectiveFamily);
					const hit = cache.getCachedVisionEmbedding(hash);
					if (hit && hit.live !== false) return { hash, hit };
				} catch {
					// Hashing failed (malformed data URL etc.); proceed without
					// cache rather than failing the request.
				}
				return null;
			})();
			const projected = cached?.hit
				? {
						tokens: cached.hit.tokens,
						tokenCount: cached.hit.tokenCount,
						hiddenSize: cached.hit.hiddenSize,
					}
				: undefined;
			const result = await backend.describe(request, {
				projectedTokens: projected,
			});
			return {
				...result,
				cacheHit: Boolean(projected),
			};
		},
	};
}
