import { describe, expect, it } from "vitest";
import {
	type ImageGenRuntimeProfile,
	resolveDefaultImageGenModel,
	selectImageGenBackends,
} from "./backend-selector";

/**
 * Image-gen backend selection (#8848 / WS3).
 *
 * `selectImageGenBackends` is the deterministic per-platform decision tree the
 * arbiter walks at model-load time; `resolveDefaultImageGenModel` maps a tier
 * id to a concrete diffusion file. The whole `imagegen/` dir was untested, so a
 * regression in the accelerator ordering or the `requiredAccelerator` override
 * (which exists precisely so release smoke tests can't silently fall back to
 * CPU) would pass unnoticed. Both functions are pure.
 */

const profile = (
	o: Partial<ImageGenRuntimeProfile>,
): ImageGenRuntimeProfile => ({
	platform: "linux",
	arch: "x64",
	...o,
});

describe("selectImageGenBackends — requiredAccelerator override", () => {
	it("pins a single backend for each explicit accelerator", () => {
		expect(
			selectImageGenBackends(profile({ requiredAccelerator: "cuda" })),
		).toEqual([{ backendId: "sd-cpp", accelerator: "cuda" }]);
		expect(
			selectImageGenBackends(profile({ requiredAccelerator: "vulkan" })),
		).toEqual([{ backendId: "sd-cpp", accelerator: "vulkan" }]);
		expect(
			selectImageGenBackends(profile({ requiredAccelerator: "cpu" })),
		).toEqual([{ backendId: "sd-cpp", accelerator: "cpu" }]);
		expect(
			selectImageGenBackends(profile({ requiredAccelerator: "coreml" })),
		).toEqual([{ backendId: "coreml", accelerator: "coreml" }]);
		expect(
			selectImageGenBackends(profile({ requiredAccelerator: "tensorrt" })),
		).toEqual([{ backendId: "tensorrt", accelerator: "tensorrt" }]);
	});

	it("routes a required metal accelerator to mflux only on Apple Silicon", () => {
		expect(
			selectImageGenBackends(
				profile({
					requiredAccelerator: "metal",
					platform: "darwin",
					arch: "arm64",
				}),
			),
		).toEqual([{ backendId: "mflux", accelerator: "metal" }]);
		// Intel Mac (or anything not darwin/arm64) → sd-cpp metal.
		expect(
			selectImageGenBackends(
				profile({
					requiredAccelerator: "metal",
					platform: "darwin",
					arch: "x64",
				}),
			),
		).toEqual([{ backendId: "sd-cpp", accelerator: "metal" }]);
	});

	it("lets the explicit override win over the mobile shells", () => {
		expect(
			selectImageGenBackends(
				profile({ requiredAccelerator: "cuda", isIos: true }),
			),
		).toEqual([{ backendId: "sd-cpp", accelerator: "cuda" }]);
	});
});

describe("selectImageGenBackends — platform policy", () => {
	it("returns Core ML only on iOS and aosp only on Android", () => {
		expect(selectImageGenBackends(profile({ isIos: true }))).toEqual([
			{ backendId: "coreml", accelerator: "coreml" },
		]);
		expect(selectImageGenBackends(profile({ isAndroid: true }))).toEqual([
			{ backendId: "aosp", accelerator: "auto" },
		]);
	});

	it("orders mflux→sd-cpp on Apple Silicon, sd-cpp auto→cpu on Intel Mac", () => {
		expect(
			selectImageGenBackends(profile({ platform: "darwin", arch: "arm64" })),
		).toEqual([
			{ backendId: "mflux", accelerator: "metal" },
			{ backendId: "sd-cpp", accelerator: "cpu" },
		]);
		expect(
			selectImageGenBackends(profile({ platform: "darwin", arch: "x64" })),
		).toEqual([
			{ backendId: "sd-cpp", accelerator: "auto" },
			{ backendId: "sd-cpp", accelerator: "cpu" },
		]);
	});

	it("orders tensorrt→cuda→cpu on Windows NVIDIA and vulkan→cpu on Windows AMD", () => {
		expect(
			selectImageGenBackends(profile({ platform: "win32", gpu: "nvidia" })),
		).toEqual([
			{ backendId: "tensorrt", accelerator: "tensorrt" },
			{ backendId: "sd-cpp", accelerator: "cuda" },
			{ backendId: "sd-cpp", accelerator: "cpu" },
		]);
		expect(
			selectImageGenBackends(profile({ platform: "win32", gpu: "amd" })),
		).toEqual([
			{ backendId: "sd-cpp", accelerator: "vulkan" },
			{ backendId: "sd-cpp", accelerator: "cpu" },
		]);
		expect(
			selectImageGenBackends(profile({ platform: "win32", gpu: "none" })),
		).toEqual([{ backendId: "sd-cpp", accelerator: "cpu" }]);
	});

	it("gates Linux NVIDIA CUDA on real sd-cpp evidence", () => {
		// GPU vendor alone is NOT evidence the installed binary has CUDA.
		expect(
			selectImageGenBackends(profile({ platform: "linux", gpu: "nvidia" })),
		).toEqual([{ backendId: "sd-cpp", accelerator: "cpu" }]);
		// cudaCapable evidence promotes CUDA ahead of the CPU fallback.
		expect(
			selectImageGenBackends(
				profile({
					platform: "linux",
					gpu: "nvidia",
					sdCpp: { cudaCapable: true },
				}),
			),
		).toEqual([
			{ backendId: "sd-cpp", accelerator: "cuda" },
			{ backendId: "sd-cpp", accelerator: "cpu" },
		]);
		// an accelerators list that includes cuda is equivalent evidence.
		expect(
			selectImageGenBackends(
				profile({
					platform: "linux",
					gpu: "nvidia",
					sdCpp: { accelerators: ["cuda"] },
				}),
			),
		).toEqual([
			{ backendId: "sd-cpp", accelerator: "cuda" },
			{ backendId: "sd-cpp", accelerator: "cpu" },
		]);
	});

	it("falls back to sd-cpp CPU for an unknown platform", () => {
		expect(
			selectImageGenBackends(
				profile({ platform: "freebsd" as ImageGenRuntimeProfile["platform"] }),
			),
		).toEqual([{ backendId: "sd-cpp", accelerator: "cpu" }]);
	});
});

describe("resolveDefaultImageGenModel", () => {
	it("resolves a small tier to the SD-1.5 file (no split-diffusion fields)", () => {
		expect(resolveDefaultImageGenModel("eliza-1-2b")).toEqual({
			modelId: "imagegen-sd-1_5-q5_0",
			file: "imagegen/sd-1.5-Q5_0.gguf",
		});
	});

	it("resolves a large tier to the SD-1.5 file while split encoders are not default-eligible", () => {
		expect(resolveDefaultImageGenModel("eliza-1-9b")).toEqual({
			modelId: "imagegen-sd-1_5-q5_0",
			file: "imagegen/sd-1.5-Q5_0.gguf",
		});
	});

	it("echoes back a bare model id that matches a known tier entry", () => {
		expect(resolveDefaultImageGenModel("imagegen-sd-1_5-q5_0")).toMatchObject({
			modelId: "imagegen-sd-1_5-q5_0",
			file: "imagegen/sd-1.5-Q5_0.gguf",
		});
	});

	it("returns null for an unknown key", () => {
		expect(resolveDefaultImageGenModel("does-not-exist")).toBeNull();
	});
});
