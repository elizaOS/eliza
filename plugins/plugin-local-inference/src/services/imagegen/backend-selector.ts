/**
 * Image-gen backend-pick logic (WS3).
 *
 * Given a runtime platform + accelerator hint, return the ordered list
 * of backend ids to try. The arbiter walks this list at load time and
 * stops at the first backend that resolves to a live handle. A backend
 * that throws `ImageGenBackendUnavailableError` lets the selector fall
 * through to the next.
 *
 * Per-platform policy:
 *
 *   - **macOS Apple Silicon**: `mflux` (MLX) → `sd-cpp` (CPU fallback).
 *     mflux is Metal-accelerated through MLX; sd-cpp-CPU is the
 *     functional last-resort if the venv isn't installed.
 *   - **macOS Intel**: `sd-cpp` (Metal/CPU). MLX requires Apple Silicon;
 *     mflux is skipped on Intel Macs.
 *   - **iOS**: `coreml` only. There is no sd-cpp on iOS — Core ML is
 *     the only sanctioned acceleration path.
 *   - **Linux + NVIDIA**: `sd-cpp` (CUDA build) only. TensorRT is
 *     Windows-only in the bundle plan; Linux NVIDIA users get the
 *     CUDA-built sd-cpp.
 *   - **Linux + AMD/Intel**: `sd-cpp --vulkan` → `sd-cpp` (CPU fallback).
 *   - **Linux + CPU**: `sd-cpp` (CPU).
 *   - **Windows + NVIDIA**: `tensorrt` → `sd-cpp` (CUDA) → `sd-cpp` (CPU).
 *   - **Windows + AMD/Intel**: `sd-cpp --vulkan` → `sd-cpp` (CPU).
 *   - **Android (AOSP)**: `aosp` (libeliza-llama-shim with Vulkan/OpenCL,
 *     handled by `plugin-aosp-local-inference`). No second backend on
 *     mobile — falling back to CPU sd-cpp on a phone is too slow to be
 *     useful and would just block the UI.
 *
 * The selector intentionally does NOT account for tier or model
 * compatibility — that's the catalog's job. A 27B-tier user on a
 * Vulkan-only Linux box doesn't change the selector; it just changes
 * which model the chosen backend loads.
 */

import type { ImageGenBackend } from "./types";

/** Per-platform runtime fingerprint the selector consumes. */
export interface ImageGenRuntimeProfile {
	/** Node-style `process.platform`: `"linux" | "darwin" | "win32" | "android"`. */
	platform: NodeJS.Platform | "android" | "ios";
	/**
	 * `process.arch` (`"x64"` | `"arm64"`). Apple Silicon = `"arm64"` on
	 * `"darwin"`. Intel Mac = `"x64"` on `"darwin"`.
	 */
	arch: NodeJS.Architecture | string;
	/**
	 * GPU vendor hint, when detected. `"nvidia"` enables CUDA / TensorRT
	 * paths; `"amd"` and `"intel"` favour Vulkan. `"apple"` is implied by
	 * platform=darwin+arch=arm64.
	 */
	gpu?: "nvidia" | "amd" | "intel" | "apple" | "none";
	/**
	 * True when running inside the iOS Capacitor shell. We can't infer
	 * from `process.platform` alone because Capacitor reports `"ios"`
	 * but Node's typings only know `darwin`/`linux`/etc.
	 */
	isIos?: boolean;
	/**
	 * True when running inside the Android Capacitor / `plugin-aosp-local-inference`
	 * shell. Node reports `"linux"` on AOSP, so we need an explicit signal.
	 */
	isAndroid?: boolean;
}

export type ImageGenBackendId = ImageGenBackend["id"];

/**
 * Ordered list of `(backendId, accelerator)` pairs to try. The caller
 * picks the first one whose backend loader returns a live handle.
 *
 * Accelerator strings match `ImageGenLoadArgs.accelerator`.
 */
export interface ImageGenBackendChoice {
	backendId: ImageGenBackendId;
	accelerator?:
		| "auto"
		| "cpu"
		| "cuda"
		| "vulkan"
		| "metal"
		| "coreml"
		| "tensorrt";
}

export function selectImageGenBackends(
	profile: ImageGenRuntimeProfile,
): readonly ImageGenBackendChoice[] {
	if (profile.isIos) {
		// iOS Capacitor: Core ML only. No fallback — sd-cpp is not
		// shipped on iOS and falling back to nothing surfaces a clean
		// "unavailable on this device" error in the UI.
		return [{ backendId: "coreml", accelerator: "coreml" }];
	}
	if (profile.isAndroid) {
		// AOSP: libeliza-llama-shim with Vulkan/OpenCL. The JNI handles
		// the acceleration path; from the JS side we just request "auto"
		// and let the shim pick.
		return [{ backendId: "aosp", accelerator: "auto" }];
	}

	if (profile.platform === "darwin") {
		if (profile.arch === "arm64") {
			// Apple Silicon: mflux (MLX/Metal) first; sd-cpp CPU as
			// last resort if the venv isn't installed.
			return [
				{ backendId: "mflux", accelerator: "metal" },
				{ backendId: "sd-cpp", accelerator: "cpu" },
			];
		}
		// Intel Mac. mflux requires Apple Silicon; sd-cpp Metal is the
		// reasonable fast path. Builds for Intel Mac sd-cpp are sparse;
		// CPU is the safe default.
		return [
			{ backendId: "sd-cpp", accelerator: "auto" },
			{ backendId: "sd-cpp", accelerator: "cpu" },
		];
	}

	if (profile.platform === "win32") {
		if (profile.gpu === "nvidia") {
			return [
				{ backendId: "tensorrt", accelerator: "tensorrt" },
				{ backendId: "sd-cpp", accelerator: "cuda" },
				{ backendId: "sd-cpp", accelerator: "cpu" },
			];
		}
		if (profile.gpu === "amd" || profile.gpu === "intel") {
			return [
				{ backendId: "sd-cpp", accelerator: "vulkan" },
				{ backendId: "sd-cpp", accelerator: "cpu" },
			];
		}
		return [{ backendId: "sd-cpp", accelerator: "cpu" }];
	}

	// Linux (and any other Unix the runtime reports). sd-cpp covers
	// CUDA, Vulkan, and CPU through the same binary; we just pick the
	// accelerator order.
	if (profile.platform === "linux") {
		if (profile.gpu === "nvidia") {
			return [
				{ backendId: "sd-cpp", accelerator: "cuda" },
				{ backendId: "sd-cpp", accelerator: "cpu" },
			];
		}
		if (profile.gpu === "amd" || profile.gpu === "intel") {
			return [
				{ backendId: "sd-cpp", accelerator: "vulkan" },
				{ backendId: "sd-cpp", accelerator: "cpu" },
			];
		}
		return [{ backendId: "sd-cpp", accelerator: "cpu" }];
	}

	// Unknown platform — try sd-cpp CPU and fail cleanly if it isn't
	// installed.
	return [{ backendId: "sd-cpp", accelerator: "cpu" }];
}

/**
 * Tier → default image-gen model id. Mirrors
 * `eliza/docs/ELIZA_1_BUNDLE_EXTRAS.json` and the WS10 golden test's
 * `PER_TIER_DEFAULT` map. Used by the WS3 capability registration to
 * resolve the catalog's bare tier id into a concrete diffusion file.
 */
export const TIER_TO_DEFAULT_IMAGE_MODEL: Readonly<
	Record<string, { modelId: string; file: string }>
> = {
	"eliza-1-0_8b": {
		modelId: "imagegen-sd-1_5-q5_0",
		file: "imagegen/sd-1.5-Q5_0.gguf",
	},
	"eliza-1-2b": {
		modelId: "imagegen-sd-1_5-q5_0",
		file: "imagegen/sd-1.5-Q5_0.gguf",
	},
	"eliza-1-4b": {
		modelId: "imagegen-sd-1_5-q5_0",
		file: "imagegen/sd-1.5-Q5_0.gguf",
	},
	"eliza-1-9b": {
		modelId: "imagegen-z-image-turbo-q4_k_m",
		file: "imagegen/z-image-turbo-Q4_K_M.gguf",
	},
	"eliza-1-27b": {
		modelId: "imagegen-z-image-turbo-q4_k_m",
		file: "imagegen/z-image-turbo-Q4_K_M.gguf",
	},
	"eliza-1-27b-256k": {
		modelId: "imagegen-z-image-turbo-q4_k_m",
		file: "imagegen/z-image-turbo-Q4_K_M.gguf",
	},
};

/**
 * Resolve a tier id (or raw model id) to its default image-gen model.
 * Returns null when the input doesn't match any known tier — caller
 * surfaces a clear error.
 */
export function resolveDefaultImageGenModel(
	keyOrTier: string,
): { modelId: string; file: string } | null {
	const direct = TIER_TO_DEFAULT_IMAGE_MODEL[keyOrTier];
	if (direct) return direct;
	// Allow callers to pass the bare model id straight through; if it
	// matches a known model file in the per-tier map we echo it back.
	for (const entry of Object.values(TIER_TO_DEFAULT_IMAGE_MODEL)) {
		if (entry.modelId === keyOrTier) return entry;
	}
	return null;
}
