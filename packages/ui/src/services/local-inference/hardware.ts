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
import {
  adviseDiskSpace,
  type DiskSpace,
  type DiskSpaceWarning,
  probeDiskSpace,
} from "./disk-space";
import type {
  HardwareProbe,
  ModelBucket,
  OpenVinoDeviceKind,
  OpenVinoHardwareProbe,
} from "./types";

const BYTES_PER_GB = 1024 ** 3;
const NODE_LLAMA_CPP_MODULE_ID = "node-llama-cpp";

function bytesToGb(bytes: number): number {
  return Math.round((bytes / BYTES_PER_GB) * 10) / 10;
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

type LlamaBindingGpu = "cuda" | "metal" | "vulkan" | false;

interface LlamaBinding {
  gpu: LlamaBindingGpu;
  getVramState(): Promise<{ total: number; used: number; free: number }>;
  dispose?(): Promise<void>;
}

interface LlamaBindingModule {
  getLlama(options?: { gpu?: "auto" | false }): Promise<LlamaBinding>;
}

async function loadLlamaBinding(): Promise<LlamaBindingModule | null> {
  try {
    const mod = (await import(
      /* @vite-ignore */ NODE_LLAMA_CPP_MODULE_ID
    )) as unknown;
    if (
      mod &&
      typeof mod === "object" &&
      "getLlama" in mod &&
      typeof (mod as { getLlama: unknown }).getLlama === "function"
    ) {
      return mod as LlamaBindingModule;
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

  const llama = await binding.getLlama({ gpu: "auto" });
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

export type OnboardingMemoryFit = "fits" | "tight" | "wontfit";
export type OnboardingDiskFit = "fits" | "low-disk" | "critical-disk";
export type OnboardingRecommendation =
  | "local-ok"
  | "local-with-warning"
  | "cloud-only";

export interface OnboardingHardwareAdvice {
  memory: OnboardingMemoryFit;
  disk: OnboardingDiskFit;
  recommended: OnboardingRecommendation;
  reasons: string[];
}

export interface OnboardingHardwareModel {
  sizeBytes: number;
  ramGbRequired: number;
}

export interface OnboardingHardwareOptions {
  workspacePath?: string;
}

function diskFitFromWarning(
  warning: DiskSpaceWarning | undefined,
): OnboardingDiskFit {
  if (warning === "critical-disk") return "critical-disk";
  if (warning === "low-disk") return "low-disk";
  return "fits";
}

function memoryReason(
  memory: OnboardingMemoryFit,
  model: OnboardingHardwareModel,
): string | null {
  if (memory === "wontfit") {
    return `Less than ${model.ramGbRequired} GB of usable memory for this model`;
  }
  if (memory === "tight") {
    return "Memory is close to the model requirement; performance may suffer";
  }
  return null;
}

function diskReason(
  disk: OnboardingDiskFit,
  probe: DiskSpace,
  modelSizeBytes: number,
): string | null {
  const freeGb = Math.max(
    0,
    Math.round((probe.freeBytes / (1024 ** 3)) * 10) / 10,
  );
  if (disk === "critical-disk") {
    return `Only ${freeGb} GB free disk space — not enough to download this model`;
  }
  if (disk === "low-disk") {
    const modelGb = Math.round((modelSizeBytes / (1024 ** 3)) * 10) / 10;
    return `Low free disk space (${freeGb} GB) for a ${modelGb} GB model plus safety margin`;
  }
  return null;
}

function recommendationFrom(
  memory: OnboardingMemoryFit,
  disk: OnboardingDiskFit,
): OnboardingRecommendation {
  if (memory === "wontfit" || disk === "critical-disk") return "cloud-only";
  if (memory === "tight" || disk === "low-disk") return "local-with-warning";
  return "local-ok";
}

export async function assessOnboardingHardware(
  model: OnboardingHardwareModel,
  opts: OnboardingHardwareOptions = {},
): Promise<OnboardingHardwareAdvice> {
  const probe = await probeHardware();
  const modelSizeGb = model.sizeBytes / (1024 ** 3);
  const memory = assessFit(probe, modelSizeGb, model.ramGbRequired);
  const workspacePath = opts.workspacePath ?? os.homedir();
  const diskProbe = await probeDiskSpace(workspacePath);
  const diskAdvice = adviseDiskSpace(diskProbe, model.sizeBytes);
  const disk = diskFitFromWarning(diskAdvice.warning);
  const reasons: string[] = [];
  const memReason = memoryReason(memory, model);
  if (memReason) reasons.push(memReason);
  const dReason = diskReason(disk, diskProbe, model.sizeBytes);
  if (dReason) reasons.push(dReason);
  return {
    memory,
    disk,
    recommended: recommendationFrom(memory, disk),
    reasons,
  };
}
