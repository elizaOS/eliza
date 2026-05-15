/**
 * Hardware probe for local inference sizing.
 *
 * Uses `node-llama-cpp` when available to read GPU backend + VRAM. Falls back
 * to Node's `os` module when the binding isn't installed — we don't require
 * the plugin to be loaded for the probe endpoint to return useful data.
 *
 * Dynamic import is intentional: the binding pulls a native prebuilt that we
 * don't want eagerly required at module-load time (breaks CI environments
 * without the trusted-dependency flag).
 */
import fs from "node:fs";
import os from "node:os";

const BYTES_PER_GB = 1024 ** 3;
function bytesToGb(bytes) {
	return Math.round((bytes / BYTES_PER_GB) * 10) / 10;
}
/**
 * Pick a default bucket based on total available memory and architecture.
 *
 * On Apple Silicon the GPU shares system RAM, so shared memory acts as VRAM.
 * On discrete-GPU x86 boxes we weight VRAM higher than system RAM.
 */
function recommendBucket(totalRamGb, vramGb, appleSilicon) {
	const effective = appleSilicon
		? totalRamGb
		: vramGb > 0
			? Math.max(vramGb * 1.25, totalRamGb * 0.5)
			: totalRamGb * 0.5;
	if (effective >= 36) return "xl";
	if (effective >= 18) return "large";
	if (effective >= 9) return "mid";
	return "small";
}
async function loadLlamaBinding() {
	try {
		const mod = await import("node-llama-cpp");
		if (
			mod &&
			typeof mod === "object" &&
			"getLlama" in mod &&
			typeof mod.getLlama === "function"
		) {
			return mod;
		}
		return null;
	} catch {
		// Binding not installed or prebuilt missing. That's an expected case when
		// the local-ai plugin is not enabled; we return null so the probe falls
		// back to OS-level detection.
		return null;
	}
}
const OPENVINO_LINUX_GPU_PACKAGES = [
	"intel-opencl-icd",
	"libigc2",
	"libigdfcl2",
];
function readableEntries(dir, host, prefix) {
	if (!pathExists(dir, host.existsSync)) return [];
	try {
		return host
			.readdirSync(dir)
			.filter((entry) => entry.startsWith(prefix))
			.map((entry) => `${dir}/${entry}`);
	} catch {
		return [];
	}
}
function pathExists(path, existsSync) {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}
function hasAny(paths, existsSync) {
	return paths.some((candidate) => pathExists(candidate, existsSync));
}
export function detectOpenVinoDevices(host = {}) {
	const platform = host.platform ?? process.platform;
	const env = host.env ?? process.env;
	const existsSync = host.existsSync ?? fs.existsSync;
	const readdirSync =
		host.readdirSync ?? ((dir) => fs.readdirSync(dir, { encoding: "utf8" }));
	const io = { existsSync, readdirSync };
	const runtimeAvailable =
		Boolean(env.OpenVINO_DIR || env.INTEL_OPENVINO_DIR) ||
		hasAny(
			[
				"/opt/intel/openvino/setupvars.sh",
				"/opt/intel/openvino_2026/setupvars.sh",
				"/usr/lib/x86_64-linux-gnu/libopenvino.so",
				"/usr/lib/x86_64-linux-gnu/libopenvino.so.0",
				"/usr/lib/aarch64-linux-gnu/libopenvino.so",
				"/usr/lib/aarch64-linux-gnu/libopenvino.so.0",
			],
			existsSync,
		);
	const renderNodes =
		platform === "linux" ? readableEntries("/dev/dri", io, "renderD") : [];
	const accelNodes =
		platform === "linux" ? readableEntries("/dev/accel", io, "accel") : [];
	const intelComputeRuntimeReady =
		platform === "linux" &&
		hasAny(
			[
				"/usr/lib/x86_64-linux-gnu/intel-opencl/libigdrcl.so",
				"/usr/lib/x86_64-linux-gnu/libigc.so.1",
				"/usr/lib/x86_64-linux-gnu/libigdfcl.so.1",
				"/usr/lib/aarch64-linux-gnu/intel-opencl/libigdrcl.so",
				"/usr/lib/aarch64-linux-gnu/libigc.so.1",
				"/usr/lib/aarch64-linux-gnu/libigdfcl.so.1",
			],
			existsSync,
		);
	const devices = [];
	if (runtimeAvailable) devices.push("CPU");
	if (runtimeAvailable && renderNodes.length > 0 && intelComputeRuntimeReady) {
		devices.push("GPU");
	}
	if (runtimeAvailable && accelNodes.length > 0) devices.push("NPU");
	const warnings = [];
	if (renderNodes.length > 0 && !intelComputeRuntimeReady) {
		warnings.push(
			`OpenVINO GPU needs Intel Compute Runtime packages: ${OPENVINO_LINUX_GPU_PACKAGES.join(", ")}`,
		);
	}
	if ((renderNodes.length > 0 || accelNodes.length > 0) && !runtimeAvailable) {
		warnings.push(
			"Intel accelerator nodes are present, but OpenVINO Runtime was not found; source setupvars.sh or set OpenVINO_DIR.",
		);
	}
	return {
		runtimeAvailable,
		devices,
		gpu: {
			renderNodes,
			computeRuntimeReady: intelComputeRuntimeReady,
			missingLinuxPackages:
				renderNodes.length > 0 && !intelComputeRuntimeReady
					? [...OPENVINO_LINUX_GPU_PACKAGES]
					: [],
		},
		npu: { accelNodes },
		recommendedAsrDevice: devices.includes("NPU")
			? "NPU"
			: devices.includes("GPU")
				? "GPU"
				: devices.includes("CPU")
					? "CPU"
					: null,
		warnings,
	};
}
/**
 * Read current system + GPU state. Cheap enough to call per-request; no
 * internal caching so the UI always reflects live VRAM usage.
 */
export async function probeHardware() {
	const totalRamBytes = os.totalmem();
	const freeRamBytes = os.freemem();
	const cpuCores = os.cpus().length;
	const platform = process.platform;
	const arch = process.arch;
	const appleSilicon = platform === "darwin" && arch === "arm64";
	const openvino = detectOpenVinoDevices();
	const binding = await loadLlamaBinding();
	if (!binding) {
		// OS-only fallback: we cannot detect GPU without the binding, so treat as
		// CPU-only. On Apple Silicon shared memory still makes mid-sized models
		// viable, which `recommendBucket` handles.
		const totalRamGb = bytesToGb(totalRamBytes);
		return {
			totalRamGb,
			freeRamGb: bytesToGb(freeRamBytes),
			gpu: null,
			cpuCores,
			platform,
			arch,
			appleSilicon,
			recommendedBucket: recommendBucket(totalRamGb, 0, appleSilicon),
			source: "os-fallback",
			openvino,
		};
	}
	// `loadLlamaBinding()` catches *import* failures, but the binding's
	// `getLlama()` can still throw during native init — observed on the
	// electrobun launcher as the cryptic TDZ-style error
	// `Cannot access '' before initialization.` coming from inside
	// `node-llama-cpp`'s prebuilt native binding. The launcher then
	// bubbles that string up through `/api/local-inference/hardware`
	// (returns 500), `/api/local-inference/active` (status: "error"),
	// and any other call site that depends on the probe. Wrap the init
	// call in a try/catch so we fall back to the same OS-only probe
	// we use when the import itself was unavailable.
	let llama;
	try {
		llama = await binding.getLlama({ gpu: "auto" });
	} catch (err) {
		console.warn(
			"[hardware] getLlama() threw during native init, falling back to OS probe:",
			err,
		);
		const totalRamGb = bytesToGb(totalRamBytes);
		return {
			totalRamGb,
			freeRamGb: bytesToGb(freeRamBytes),
			gpu: null,
			cpuCores,
			platform,
			arch,
			appleSilicon,
			recommendedBucket: recommendBucket(totalRamGb, 0, appleSilicon),
			source: "os-fallback",
			openvino,
		};
	}
	const totalRamGb = bytesToGb(totalRamBytes);
	const freeRamGb = bytesToGb(freeRamBytes);
	if (llama.gpu === false) {
		return {
			totalRamGb,
			freeRamGb,
			gpu: null,
			cpuCores,
			platform,
			arch,
			appleSilicon,
			recommendedBucket: recommendBucket(totalRamGb, 0, appleSilicon),
			source: "node-llama-cpp",
			openvino,
		};
	}
	const vram = await llama.getVramState();
	const totalVramGb = bytesToGb(vram.total);
	const freeVramGb = bytesToGb(vram.free);
	return {
		totalRamGb,
		freeRamGb,
		gpu: {
			backend: llama.gpu,
			totalVramGb,
			freeVramGb,
		},
		cpuCores,
		platform,
		arch,
		appleSilicon,
		recommendedBucket: recommendBucket(totalRamGb, totalVramGb, appleSilicon),
		source: "node-llama-cpp",
		openvino,
	};
}
/**
 * Map a hardware probe onto the Eliza-1 device-capability snapshot used by
 * the manifest validator and the bundle downloader.
 *
 * Backends: `cpu` is always present (the floor). A detected GPU backend is
 * added when `node-llama-cpp` reports one (`metal` on Apple Silicon, `cuda`
 * on NVIDIA, `vulkan` on cross-vendor Linux/Android). We do not synthesize
 * `rocm` from the probe — `node-llama-cpp` reports AMD as `vulkan` on the
 * builds we ship, and a bundle that only verified ROCm but not Vulkan is
 * legitimately not installable here.
 *
 * `ramMb` is total system RAM. On Apple Silicon that is also the GPU's
 * working memory; on discrete-GPU boxes the recommendation engine layers
 * its own VRAM-vs-RAM heuristics on top, but the bundle's `ramBudgetMb.min`
 * is a system-RAM floor in every manifest.
 */
export function deviceCapsFromProbe(probe) {
	const backends = ["cpu"];
	const gpuBackend = probe.gpu?.backend;
	if (
		gpuBackend === "metal" ||
		gpuBackend === "cuda" ||
		gpuBackend === "vulkan"
	) {
		backends.unshift(gpuBackend);
	}
	return {
		availableBackends: backends,
		ramMb: Math.round(probe.totalRamGb * 1024),
	};
}
/**
 * Compatibility assessment for a specific model given current hardware.
 *
 * Green/fits: comfortable headroom (model < 70% of effective memory).
 * Yellow/tight: will run but may swap or stutter under load.
 * Red/wontfit: exceeds available memory.
 */
export function assessFit(probe, modelSizeGb, minRamGb) {
	const effectiveGb = probe.appleSilicon
		? probe.totalRamGb
		: probe.gpu
			? Math.max(probe.gpu.totalVramGb, probe.totalRamGb * 0.5)
			: probe.totalRamGb * 0.5;
	if (effectiveGb < minRamGb) return "wontfit";
	if (modelSizeGb > effectiveGb * 0.9) return "wontfit";
	if (modelSizeGb > effectiveGb * 0.7) return "tight";
	return "fits";
}
//# sourceMappingURL=hardware.js.map
