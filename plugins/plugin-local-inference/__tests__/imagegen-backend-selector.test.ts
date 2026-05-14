/**
 * WS3 backend-selector tests.
 *
 * For each (platform, arch, GPU) profile, confirm the returned ordered
 * backend list matches the WS3 selection policy doc'd at the top of
 * `services/imagegen/backend-selector.ts`.
 */

import { describe, expect, it } from "vitest";
import {
	selectImageGenBackends,
	type ImageGenRuntimeProfile,
} from "../src/services/imagegen/backend-selector";

function ids(profile: ImageGenRuntimeProfile): string[] {
	return selectImageGenBackends(profile).map((c) => `${c.backendId}:${c.accelerator ?? "default"}`);
}

describe("WS3 backend-selector", () => {
	it("iOS Capacitor → coreml only", () => {
		expect(ids({ platform: "darwin", arch: "arm64", isIos: true })).toEqual([
			"coreml:coreml",
		]);
	});

	it("Android AOSP → aosp only", () => {
		// AOSP reports linux; the explicit isAndroid flag is what flips it.
		expect(ids({ platform: "linux", arch: "arm64", isAndroid: true })).toEqual([
			"aosp:auto",
		]);
	});

	it("macOS Apple Silicon → mflux then sd-cpp CPU", () => {
		expect(ids({ platform: "darwin", arch: "arm64", gpu: "apple" })).toEqual([
			"mflux:metal",
			"sd-cpp:cpu",
		]);
	});

	it("macOS Intel → sd-cpp auto then CPU", () => {
		expect(ids({ platform: "darwin", arch: "x64" })).toEqual([
			"sd-cpp:auto",
			"sd-cpp:cpu",
		]);
	});

	it("Linux NVIDIA → sd-cpp CUDA then CPU", () => {
		expect(ids({ platform: "linux", arch: "x64", gpu: "nvidia" })).toEqual([
			"sd-cpp:cuda",
			"sd-cpp:cpu",
		]);
	});

	it("Linux AMD → sd-cpp Vulkan then CPU", () => {
		expect(ids({ platform: "linux", arch: "x64", gpu: "amd" })).toEqual([
			"sd-cpp:vulkan",
			"sd-cpp:cpu",
		]);
	});

	it("Linux Intel iGPU → sd-cpp Vulkan then CPU", () => {
		expect(ids({ platform: "linux", arch: "x64", gpu: "intel" })).toEqual([
			"sd-cpp:vulkan",
			"sd-cpp:cpu",
		]);
	});

	it("Linux no GPU → sd-cpp CPU only", () => {
		expect(ids({ platform: "linux", arch: "x64" })).toEqual(["sd-cpp:cpu"]);
	});

	it("Windows NVIDIA → tensorrt then sd-cpp CUDA then CPU", () => {
		expect(ids({ platform: "win32", arch: "x64", gpu: "nvidia" })).toEqual([
			"tensorrt:tensorrt",
			"sd-cpp:cuda",
			"sd-cpp:cpu",
		]);
	});

	it("Windows AMD → sd-cpp Vulkan then CPU", () => {
		expect(ids({ platform: "win32", arch: "x64", gpu: "amd" })).toEqual([
			"sd-cpp:vulkan",
			"sd-cpp:cpu",
		]);
	});

	it("Windows no GPU → sd-cpp CPU only", () => {
		expect(ids({ platform: "win32", arch: "x64" })).toEqual(["sd-cpp:cpu"]);
	});

	it("Unknown platform → sd-cpp CPU only", () => {
		// Cast: TS doesn't model an unknown platform; we exercise the
		// final fallback branch.
		const unknownPlatform = "freebsd" as ImageGenRuntimeProfile["platform"];
		expect(ids({ platform: unknownPlatform, arch: "x64" })).toEqual([
			"sd-cpp:cpu",
		]);
	});
});
