/**
 * Hardware probe for local inference sizing.
 *
 * GPU backend + VRAM come from cheap, pre-load host queries: `nvidia-smi` for
 * NVIDIA (`backend: "cuda"`) and Apple-Silicon detection (`backend: "metal"`,
 * unified memory). AMD/Intel are deliberately left `null` at probe time — no
 * cheap pre-load VRAM query exists for them, and guessing `vulkan` here risks a
 * hard GPU-open throw on a box whose Vulkan driver is unusable; the fused ABI
 * surfaces real VRAM after model load instead. RAM/CPU come from Node's `os`
 * module, so the probe endpoint returns useful data even without any GPU tool.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectGpu } from "./gpu-detect";
import type { Eliza1Backend, Eliza1DeviceCaps } from "./manifest";
import { elizaModelsDir } from "./paths";
import type {
	CpuFeatureProbe,
	HardwareProbe,
	ModelBucket,
	OpenVinoDeviceKind,
	OpenVinoHardwareProbe,
} from "./types";

const BYTES_PER_GB = 1024 ** 3;

function bytesToGb(bytes: number): number {
	return Math.round((bytes / BYTES_PER_GB) * 10) / 10;
}

/**
 * Free disk space (GB) on the volume that holds the models directory. Walks up
 * to the nearest existing ancestor before `statfs` so a not-yet-created models
 * dir still resolves to its parent volume. Returns `undefined` when the volume
 * cannot be stat'd (the fit check then falls back to RAM-only / mobile
 * storage), never throws.
 */
async function probeFreeDiskGb(): Promise<number | undefined> {
	try {
		let dir = elizaModelsDir();
		for (let i = 0; i < 12 && !fs.existsSync(dir); i += 1) {
			const parent = path.dirname(dir);
			if (parent === dir) break;
			dir = parent;
		}
		const stats = await fs.promises.statfs(dir);
		const available = stats.bavail * stats.bsize;
		if (!Number.isFinite(available) || available < 0) return undefined;
		return bytesToGb(available);
	} catch {
		return undefined;
	}
}

/**
 * Pick a default bucket based on total available memory and architecture.
 *
 * On Apple Silicon the GPU shares system RAM, so shared memory acts as VRAM.
 * On discrete-GPU x86 boxes we weight VRAM higher than system RAM.
 */
function recommendBucket(
	totalRamGb: number,
	vramGb: number,
	appleSilicon: boolean,
): ModelBucket {
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

interface CpuFeatureDetectionHost {
	platform?: NodeJS.Platform;
	arch?: NodeJS.Architecture;
	readFileSync?: (path: string, encoding: BufferEncoding) => string;
	execFileSync?: (
		file: string,
		args: readonly string[],
		options: { encoding: BufferEncoding; stdio: "pipe" },
	) => string;
}

const DARWIN_ARM_FEATURE_SYSCTLS: Readonly<
	Array<[keyof CpuFeatureProbe, string]>
> = [
	["dotprod", "hw.optional.arm.FEAT_DotProd"],
	["i8mm", "hw.optional.arm.FEAT_I8MM"],
	["sve", "hw.optional.arm.FEAT_SVE"],
	["sve2", "hw.optional.arm.FEAT_SVE2"],
];

function emptyCpuFeatures(): CpuFeatureProbe {
	return {
		neon: false,
		dotprod: false,
		i8mm: false,
		sve: false,
		sve2: false,
	};
}

function linuxArmFeatureTokens(cpuinfo: string): Set<string> {
	const tokens = new Set<string>();
	for (const line of cpuinfo.split(/\r?\n/)) {
		const [rawKey, rawValue] = line.split(":", 2);
		if (!rawKey || !rawValue) continue;
		const key = rawKey.trim().toLowerCase();
		if (key !== "features" && key !== "flags") continue;
		for (const token of rawValue.trim().toLowerCase().split(/\s+/)) {
			if (token) tokens.add(token);
		}
	}
	return tokens;
}

export function detectCpuFeatures(
	host: CpuFeatureDetectionHost = {},
): CpuFeatureProbe | undefined {
	const platform = host.platform ?? process.platform;
	const arch = host.arch ?? process.arch;
	if (arch !== "arm64" && arch !== "arm") return undefined;

	if (platform === "linux" || platform === "android") {
		const readFileSync = host.readFileSync ?? fs.readFileSync;
		try {
			const tokens = linuxArmFeatureTokens(
				readFileSync("/proc/cpuinfo", "utf8"),
			);
			const features = emptyCpuFeatures();
			features.neon = tokens.has("asimd") || tokens.has("neon");
			features.dotprod = tokens.has("asimddp") || tokens.has("dotprod");
			features.i8mm = tokens.has("i8mm") || tokens.has("asimdi8mm");
			features.sve = tokens.has("sve");
			features.sve2 = tokens.has("sve2");
			return features;
		} catch {
			return undefined;
		}
	}

	if (platform === "darwin") {
		const run = host.execFileSync ?? execFileSync;
		const features = emptyCpuFeatures();
		// Arm64 Darwin requires Advanced SIMD/NEON. Some macOS releases do not
		// expose a stable sysctl for it, so use the ABI guarantee for baseline.
		features.neon = true;
		for (const [feature, key] of DARWIN_ARM_FEATURE_SYSCTLS) {
			try {
				const value = run("sysctl", ["-n", key], {
					encoding: "utf8",
					stdio: "pipe",
				});
				const normalizedValue =
					typeof value === "string" ? value.trim() : value.toString().trim();
				features[feature] =
					normalizedValue === "1" || normalizedValue.toLowerCase() === "true";
			} catch {
				features[feature] = false;
			}
		}
		return features;
	}

	return undefined;
}

export function hasUsableArmCpuBackend(probe: HardwareProbe): boolean {
	if (probe.arch !== "arm64" && probe.arch !== "arm") return true;
	return probe.cpuFeatures?.neon === true;
}

/**
 * Detect the host GPU + its VRAM for device-tier classification, VRAM
 * admission, and `n_gpu_layers` sizing. Without this every box — including a
 * 24 GB discrete workstation — probes as `gpu: null` and is mis-tiered as CPU.
 *
 *  - NVIDIA: `nvidia-smi` (the cheapest real pre-load VRAM number).
 *  - Apple Silicon: unified memory, so system RAM IS the GPU working set.
 *  - AMD/Intel (Vulkan): no cheap pre-load VRAM query exists; left `null` here
 *    rather than guessed — the fused ABI surfaces real VRAM after model load.
 */
function detectProbeGpu(
	appleSilicon: boolean,
	totalRamBytes: number,
	freeRamBytes: number,
): HardwareProbe["gpu"] {
	const nvidia = detectGpu();
	if (nvidia.nvidiaPresent && nvidia.gpu) {
		const totalVramGb = bytesToGb(nvidia.gpu.totalMemoryMiB * 1024 * 1024);
		// nvidia-smi `memory.total` is capacity; an idle probe treats it as free.
		// Real free-VRAM admission happens against the live backend post-load.
		return { backend: "cuda", totalVramGb, freeVramGb: totalVramGb };
	}
	if (appleSilicon) {
		return {
			backend: "metal",
			totalVramGb: bytesToGb(totalRamBytes),
			freeVramGb: bytesToGb(freeRamBytes),
		};
	}
	return null;
}

const OPENVINO_LINUX_GPU_PACKAGES = [
	"intel-opencl-icd",
	"libigc2",
	"libigdfcl2",
] as const;

interface OpenVinoDetectionHost {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	existsSync?: (path: string) => boolean;
	readdirSync?: (path: string) => string[];
}

function readableEntries(
	dir: string,
	host: Required<Pick<OpenVinoDetectionHost, "existsSync" | "readdirSync">>,
	prefix: string,
): string[] {
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

function pathExists(
	path: string,
	existsSync: Required<OpenVinoDetectionHost>["existsSync"],
): boolean {
	try {
		return existsSync(path);
	} catch {
		return false;
	}
}

function hasAny(
	paths: string[],
	existsSync: Required<OpenVinoDetectionHost>["existsSync"],
): boolean {
	return paths.some((candidate) => pathExists(candidate, existsSync));
}

export function detectOpenVinoDevices(
	host: OpenVinoDetectionHost = {},
): OpenVinoHardwareProbe {
	const platform = host.platform ?? process.platform;
	const env = host.env ?? process.env;
	const existsSync = host.existsSync ?? fs.existsSync;
	const readdirSync =
		host.readdirSync ??
		((dir: string) => fs.readdirSync(dir, { encoding: "utf8" }) as string[]);
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
	const devices: OpenVinoDeviceKind[] = [];
	if (runtimeAvailable) devices.push("CPU");
	if (runtimeAvailable && renderNodes.length > 0 && intelComputeRuntimeReady) {
		devices.push("GPU");
	}
	if (runtimeAvailable && accelNodes.length > 0) devices.push("NPU");

	const warnings: string[] = [];
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
export async function probeHardware(): Promise<HardwareProbe> {
	const totalRamBytes = os.totalmem();
	const freeRamBytes = os.freemem();
	const cpuCores = os.cpus().length;
	const platform = process.platform;
	const arch = process.arch;
	const appleSilicon = platform === "darwin" && arch === "arm64";
	const openvino = detectOpenVinoDevices();
	const cpuFeatures = detectCpuFeatures({ platform, arch });

	const gpu = detectProbeGpu(appleSilicon, totalRamBytes, freeRamBytes);
	const totalRamGb = bytesToGb(totalRamBytes);
	const freeDiskGb = await probeFreeDiskGb();
	return {
		totalRamGb,
		freeRamGb: bytesToGb(freeRamBytes),
		...(freeDiskGb !== undefined ? { freeDiskGb } : {}),
		gpu,
		cpuCores,
		cpuFeatures,
		platform,
		arch,
		appleSilicon,
		recommendedBucket: recommendBucket(
			totalRamGb,
			gpu?.totalVramGb ?? 0,
			appleSilicon,
		),
		source: "os-fallback",
		openvino,
	};
}

/**
 * Map a hardware probe onto the Eliza-1 device-capability snapshot used by
 * the manifest validator and the bundle downloader.
 *
 * Backends: `cpu` is always present (the floor). The GPU backend the probe
 * reports is prepended — `metal` on Apple Silicon, `cuda` on NVIDIA. `vulkan`
 * is handled here too, but `probeHardware` does not yet emit it for AMD/Intel
 * (left `null` at probe time — see the module header), so an AMD/Intel box
 * currently advertises `cpu`-only caps until Vulkan detection lands (#10727).
 * We do not synthesize `rocm` from the probe: a bundle that verified ROCm but
 * not Vulkan is legitimately not installable on the builds we ship.
 *
 * `ramMb` is total system RAM. On Apple Silicon that is also the GPU's
 * working memory; on discrete-GPU boxes the recommendation engine layers
 * its own VRAM-vs-RAM heuristics on top, but the bundle's `ramBudgetMb.min`
 * is a system-RAM floor in every manifest.
 */
export function deviceCapsFromProbe(probe: HardwareProbe): Eliza1DeviceCaps {
	const backends: Eliza1Backend[] = hasUsableArmCpuBackend(probe)
		? ["cpu"]
		: [];
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
		cpuFeatures: probe.cpuFeatures,
	};
}

/**
 * Compatibility assessment for a specific model given current hardware.
 *
 * Green/fits: comfortable headroom (model < 70% of effective memory).
 * Yellow/tight: will run but may swap or stutter under load.
 * Red/wontfit: exceeds available memory.
 */
export function assessFit(
	probe: HardwareProbe,
	modelSizeGb: number,
	minRamGb: number,
): "fits" | "tight" | "wontfit" {
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
