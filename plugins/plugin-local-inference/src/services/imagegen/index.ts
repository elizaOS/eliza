/**
 * Local image-generation capability (WS3) — public entry point.
 *
 * This module is what `provider.ts` (`createImageGenerationHandler`),
 * the UI image-gen action, and any future image-gen skill imports to
 * register the capability with the WS1 MemoryArbiter.
 *
 * Wiring:
 *
 *   const arbiter = service.getMemoryArbiter();
 *   const registration = createImageGenCapabilityRegistration({
 *     loader: createDefaultImageGenLoader({ ... }),
 *   });
 *   arbiter.registerCapability(registration);
 *
 * `createImageGenCapabilityRegistration` wraps the underlying backend
 * so the arbiter's `run(request)` path:
 *
 *   1. Calls `backend.supports(request)`. If false, the arbiter throws
 *      `unsupported_request` so the caller can pick a different tier
 *      or surface a clear error.
 *   2. Calls `backend.generate(request)` and returns the result.
 *
 * The capability registers with `residentRole: "vision"` so image-gen
 * co-evicts with vision-describe — both are GPU-heavy weights with
 * comparable RAM footprints, and the arbiter's existing one-model-per-
 * role policy gives us free serialization. A vision-describe request
 * arriving while image-gen is in flight will queue, wait for the
 * generate to drain, then evict the diffusion weights and load the
 * VL weights.
 */

export {
	type AospImageGenBinding,
	type AospImageGenHandle,
	type LoadAospImageGenBackendOptions,
	loadAospImageGenBackend,
} from "./aosp-stub";
export {
	type ImageGenBackendChoice,
	type ImageGenBackendId,
	type ImageGenRuntimeProfile,
	resolveDefaultImageGenModel,
	selectImageGenBackends,
	TIER_TO_DEFAULT_IMAGE_MODEL,
} from "./backend-selector";
export {
	type CoreMlImageGenBridge,
	type LoadCoreMlImageGenBackendOptions,
	loadCoreMlImageGenBackend,
} from "./coreml-stub";
export {
	ImageGenBackendUnavailableError,
	isImageGenUnavailable,
} from "./errors";
export {
	loadMfluxImageGenBackend,
	type MfluxBackendOptions,
} from "./mflux";
export {
	loadSdCppImageGenBackend,
	type SdCppBackendOptions,
	type SdCppSpawnLike,
} from "./sd-cpp";
export {
	loadTensorRtImageGenBackend,
	type TensorRtBackendOptions,
} from "./tensorrt-stub";
export type {
	ImageGenBackend,
	ImageGenBackendLoader,
	ImageGenLoadArgs,
	ImageGenMimeType,
	ImageGenRequest,
	ImageGenResult,
} from "./types";

import type {
	ArbiterCapability,
	CapabilityRegistration,
} from "../memory-arbiter";
import { ImageGenBackendUnavailableError } from "./errors";
import type {
	ImageGenBackend,
	ImageGenBackendLoader,
	ImageGenRequest,
	ImageGenResult,
} from "./types";

export interface CreateImageGenCapabilityRegistrationOptions {
	loader: ImageGenBackendLoader;
	/**
	 * Best-effort RAM/VRAM footprint estimate for the loaded weights. The
	 * arbiter only uses this for telemetry; eviction is by priority. The
	 * default (3500 MB) matches Z-Image-Turbo Q4_K_M; small-tier SD 1.5
	 * loaders SHOULD pass ~1100.
	 */
	estimatedMb?: number;
}

/**
 * Build a `CapabilityRegistration` ready to feed to
 * `arbiter.registerCapability()`. Mirrors
 * `createVisionCapabilityRegistration` from WS2.
 */
export function createImageGenCapabilityRegistration(
	opts: CreateImageGenCapabilityRegistrationOptions,
): CapabilityRegistration<ImageGenBackend, ImageGenRequest, ImageGenResult> {
	const capability: ArbiterCapability = "image-gen";
	const loader = opts.loader;
	return {
		capability,
		// Co-evict with vision-describe. Both are GPU-heavy modalities
		// with similar load times; sharing the `vision` slot keeps the
		// resident-role table flat and lets the WS1 swap path handle
		// vision-vs-image-gen contention with the existing queue.
		residentRole: "vision",
		estimatedMb: opts.estimatedMb ?? 3500,
		async load(modelKey: string): Promise<ImageGenBackend> {
			return await loader(modelKey);
		},
		async unload(backend: ImageGenBackend): Promise<void> {
			await backend.dispose();
		},
		async run(
			backend: ImageGenBackend,
			request: ImageGenRequest,
		): Promise<ImageGenResult> {
			if (!backend.supports(request)) {
				throw new ImageGenBackendUnavailableError(
					backend.id,
					"unsupported_request",
					`[imagegen] backend "${backend.id}" does not support this request (width=${request.width ?? "default"} height=${request.height ?? "default"} scheduler=${request.scheduler ?? "default"})`,
				);
			}
			return await backend.generate(request);
		},
	};
}
