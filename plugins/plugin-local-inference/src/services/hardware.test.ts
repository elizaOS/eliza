/** Covers the hardware probe: OpenVino/GPU device detection and device-tier classification, driven by a synthetic sysfs-file detector. Deterministic. */
import { afterEach, describe, expect, it } from "vitest";
import { classifyDeviceTier } from "./device-tier";
import {
	__resetGpuDetectionCacheForTests,
	__setGpuDetectionSpawnSyncForTests,
} from "./gpu-detect";
import {
	detectCpuFeatures,
	detectOpenVinoDevices,
	deviceCapsFromProbe,
	probeHardware,
} from "./hardware";

function detector(files: Record<string, string[] | true>) {
	const existsSync = (path: string): boolean => path in files;
	const readdirSync = (path: string): string[] => {
		const value = files[path];
		return Array.isArray(value) ? value : [];
	};
	return { existsSync, readdirSync };
}

describe("detectOpenVinoDevices", () => {
	it("prefers NPU for ASR when OpenVINO runtime and accel node are present", () => {
		const probe = detectOpenVinoDevices({
			platform: "linux",
			env: { OpenVINO_DIR: "/opt/intel/openvino_2026/runtime/cmake" },
			...detector({
				"/dev/accel": ["accel0"],
			}),
		});

		expect(probe.runtimeAvailable).toBe(true);
		expect(probe.devices).toEqual(["CPU", "NPU"]);
		expect(probe.npu.accelNodes).toEqual(["/dev/accel/accel0"]);
		expect(probe.recommendedAsrDevice).toBe("NPU");
	});

	it("warns when Intel render nodes exist without the Compute Runtime stack", () => {
		const probe = detectOpenVinoDevices({
			platform: "linux",
			env: { OpenVINO_DIR: "/opt/intel/openvino_2026/runtime/cmake" },
			...detector({
				"/dev/dri": ["card0", "renderD128"],
			}),
		});

		expect(probe.devices).toEqual(["CPU"]);
		expect(probe.gpu.renderNodes).toEqual(["/dev/dri/renderD128"]);
		expect(probe.gpu.computeRuntimeReady).toBe(false);
		expect(probe.gpu.missingLinuxPackages).toEqual([
			"intel-opencl-icd",
			"libigc2",
			"libigdfcl2",
		]);
		expect(probe.warnings[0]).toContain("Intel Compute Runtime packages");
	});

	it("does not report OpenVINO devices when the runtime is not installed", () => {
		const probe = detectOpenVinoDevices({
			platform: "linux",
			env: {},
			...detector({
				"/dev/accel": ["accel0"],
				"/dev/dri": ["renderD128"],
				"/usr/lib/x86_64-linux-gnu/intel-opencl/libigdrcl.so": true,
			}),
		});

		expect(probe.runtimeAvailable).toBe(false);
		expect(probe.devices).toEqual([]);
		expect(probe.recommendedAsrDevice).toBeNull();
		expect(probe.warnings).toContain(
			"Intel accelerator nodes are present, but OpenVINO Runtime was not found; source setupvars.sh or set OpenVINO_DIR.",
		);
	});

	it("treats sandbox-denied optional system paths as unavailable", () => {
		const existsSync = (path: string): boolean => {
			throw Object.assign(
				new Error(`mobile-fs-shim: path escapes workspace root: ${path}`),
				{ code: "EACCES" },
			);
		};
		const readdirSync = (path: string): string[] => {
			throw new Error(`unexpected readdir for ${path}`);
		};

		const probe = detectOpenVinoDevices({
			platform: "linux",
			env: {},
			existsSync,
			readdirSync,
		});

		expect(probe.runtimeAvailable).toBe(false);
		expect(probe.devices).toEqual([]);
		expect(probe.gpu.renderNodes).toEqual([]);
		expect(probe.npu.accelNodes).toEqual([]);
		expect(probe.recommendedAsrDevice).toBeNull();
	});
});

describe("detectCpuFeatures", () => {
	it("maps Linux ARM cpuinfo feature tokens to the shared probe shape", () => {
		const cpuinfo = [
			"processor\t: 0",
			"Features\t: fp asimd evtstrm aes asimddp i8mm sve sve2",
			"",
		].join("\n");

		expect(
			detectCpuFeatures({
				platform: "linux",
				arch: "arm64",
				readFileSync: () => cpuinfo,
			}),
		).toEqual({
			neon: true,
			dotprod: true,
			i8mm: true,
			sve: true,
			sve2: true,
		});
	});

	it("maps Android ARM cpuinfo aliases without assuming missing features", () => {
		const cpuinfo = "Features\t: fp neon dotprod\n";

		expect(
			detectCpuFeatures({
				platform: "android",
				arch: "arm64",
				readFileSync: () => cpuinfo,
			}),
		).toEqual({
			neon: true,
			dotprod: true,
			i8mm: false,
			sve: false,
			sve2: false,
		});
	});

	it("uses Darwin sysctl keys where available and treats missing keys as false", () => {
		const values: Record<string, string> = {
			"hw.optional.arm.FEAT_DotProd": "1\n",
			"hw.optional.arm.FEAT_I8MM": "0\n",
		};

		expect(
			detectCpuFeatures({
				platform: "darwin",
				arch: "arm64",
				execFileSync: (_file, args) => {
					const key = args[1];
					if (key in values) return values[key];
					throw new Error(`unknown sysctl ${key}`);
				},
			}),
		).toEqual({
			neon: true,
			dotprod: true,
			i8mm: false,
			sve: false,
			sve2: false,
		});
	});

	it("does not claim CPU backend support for ARM when NEON evidence is absent", () => {
		expect(
			deviceCapsFromProbe({
				totalRamGb: 16,
				freeRamGb: 12,
				gpu: null,
				cpuCores: 8,
				platform: "linux",
				arch: "arm64",
				appleSilicon: false,
				recommendedBucket: "mid",
				source: "os-fallback",
			}),
		).toEqual({
			availableBackends: [],
			ramMb: 16 * 1024,
			cpuFeatures: undefined,
		});
	});
});

describe("probeHardware GPU detection", () => {
	afterEach(() => {
		__setGpuDetectionSpawnSyncForTests(null);
		__resetGpuDetectionCacheForTests();
	});

	const fakeSpawn =
		(stdout: string, status: number) =>
		(): { stdout: string; stderr: string; status: number; signal: null } => ({
			stdout,
			stderr: "",
			status,
			signal: null,
		});

	it("populates a CUDA GPU + VRAM from nvidia-smi and lifts the tier off CPU", async () => {
		// reset clears BOTH the cache and any prior override, so reset first.
		__resetGpuDetectionCacheForTests();
		__setGpuDetectionSpawnSyncForTests(
			fakeSpawn("NVIDIA GeForce RTX 4090, 24564\n", 0) as never,
		);
		const probe = await probeHardware();
		expect(probe.gpu).not.toBeNull();
		expect(probe.gpu?.backend).toBe("cuda");
		expect(probe.gpu?.totalVramGb).toBeGreaterThanOrEqual(23);
		// A 24 GB discrete GPU must not be mis-tiered as a CPU box (POOR). The tier
		// also factors host free RAM (classifyDeviceTier reads probe.freeRamGb, which
		// probeHardware fills from real os.freemem()); under parallel-suite memory
		// pressure that can dip below the OKAY gate (3 GB) and legitimately tier even
		// a 24 GB-GPU box to POOR, flaking this assertion. Pin free RAM to an adequate
		// value so this asserts the GPU-detection -> off-CPU path deterministically
		// (host free RAM is not what this test exercises).
		const probeWithAdequateRam = { ...probe, freeRamGb: 16 };
		expect(["MAX", "GOOD", "OKAY"]).toContain(
			classifyDeviceTier(probeWithAdequateRam).tier,
		);
	});

	it("reports gpu:null when nvidia-smi is absent on a non-Apple host", async () => {
		__resetGpuDetectionCacheForTests();
		__setGpuDetectionSpawnSyncForTests(fakeSpawn("", 1) as never);
		const probe = await probeHardware();
		if (probe.appleSilicon) {
			// Unified memory: the Apple GPU is always present.
			expect(probe.gpu?.backend).toBe("metal");
		} else {
			expect(probe.gpu).toBeNull();
		}
	});
});
