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

import os from "node:os";
import type { HardwareProbe, ModelBucket } from "./types";

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
