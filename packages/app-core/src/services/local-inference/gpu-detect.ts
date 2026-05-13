/**
 * NVIDIA GPU detection + profile mapping.
 *
 * Wraps `nvidia-smi` to identify the host GPU and maps it to a
 * `GpuProfileId` from `@elizaos/shared/local-inference/gpu-profiles`.
 *
 * Single-GPU only: when multiple GPUs are present, we use the first one
 * `nvidia-smi` reports (canonical CUDA device 0). We do NOT try to split
 * the model across multiple cards — that is an explicit non-goal of the
 * single-GPU profile system.
 *
 * Detection is cached after first call. Pass `force: true` to bypass the
 * cache when a fresh probe is needed (e.g. after a GPU hot-swap on a
 * laptop dock — unusual but possible).
 */

import { spawnSync } from "node:child_process";
import {
  GPU_PROFILES,
  type GpuProfile,
  type GpuProfileId,
  matchGpuProfile,
} from "@elizaos/shared";

export interface DetectedGpu {
  /** Raw GPU name from `nvidia-smi --query-gpu=name`. */
  name: string;
  /** Total VRAM in MiB as reported by `nvidia-smi`. */
  totalMemoryMiB: number;
  /** Matched profile id, or `null` when the card is not in the supported set. */
  profileId: GpuProfileId | null;
}

export interface GpuDetectionResult {
  /** `true` when `nvidia-smi` ran successfully (even if no GPU matched a profile). */
  nvidiaPresent: boolean;
  /** First GPU reported by `nvidia-smi`; `null` when no NVIDIA GPU is present. */
  gpu: DetectedGpu | null;
  /** Resolved profile, or `null` for unsupported / non-NVIDIA hosts. */
  profile: GpuProfile | null;
}

const EMPTY_RESULT: GpuDetectionResult = {
  nvidiaPresent: false,
  gpu: null,
  profile: null,
};

let cached: GpuDetectionResult | null = null;

/**
 * Detect the primary NVIDIA GPU and resolve it to a profile. Returns
 * `{ nvidiaPresent: false }` on hosts without `nvidia-smi` on PATH or
 * without an NVIDIA GPU.
 *
 * The probe runs `nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits`
 * with a 3-second timeout so a misbehaving driver cannot stall boot.
 */
export function detectGpu(opts: { force?: boolean } = {}): GpuDetectionResult {
  if (cached && !opts.force) return cached;
  cached = probe();
  return cached;
}

/** Clear the cached detection result. Used by tests. */
export function __resetGpuDetectionCacheForTests(): void {
  cached = null;
}

function probe(): GpuDetectionResult {
  const result = spawnSync(
    "nvidia-smi",
    ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
    {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error || result.status !== 0) {
    return EMPTY_RESULT;
  }
  const firstLine = result.stdout.split(/\r?\n/).find((l) => l.trim() !== "");
  if (!firstLine) return EMPTY_RESULT;

  // Format: "NVIDIA H200, 141248"
  const parts = firstLine.split(",").map((p) => p.trim());
  if (parts.length < 2) return EMPTY_RESULT;
  const name = parts[0] ?? "";
  const memMiBRaw = Number.parseInt(parts[1] ?? "", 10);
  const totalMemoryMiB = Number.isFinite(memMiBRaw) ? memMiBRaw : 0;

  const profileId = matchGpuProfile(name);
  const profile = profileId ? GPU_PROFILES[profileId] : null;

  return {
    nvidiaPresent: true,
    gpu: { name, totalMemoryMiB, profileId },
    profile,
  };
}

/**
 * Recommend a `GpuProfileId` for a synthetic GPU descriptor — used by the
 * recommender service when it already has a `HardwareProbe` and does not
 * want to re-shell out to `nvidia-smi`. Returns `null` when nothing
 * matches.
 */
export function recommendProfileFromName(name: string): GpuProfileId | null {
  return matchGpuProfile(name);
}
