/**
 * GPU detection utility for the simplified tier-profile system.
 *
 * Uses `nvidia-smi` to query the first GPU's name, total VRAM (MiB), and
 * CUDA compute capability. On success the result feeds `selectBestProfile`
 * to pick the best matching tier profile.
 *
 * **This module MUST NOT throw.** Any failure — missing binary, no GPU,
 * parse error — returns `null`. Callers treat `null` as "run without GPU
 * acceleration" and fall back to CPU/catalog defaults.
 *
 * **No model loading.** This file only spawns `nvidia-smi` for metadata
 * queries; it never starts llama-server or loads any GGUF files.
 *
 * Override: set `ELIZA_GPU_PROFILE=<id>` (e.g. `ELIZA_GPU_PROFILE=rtx-4090`)
 * to bypass detection entirely. `autoSelectProfile()` returns the named
 * profile directly without running nvidia-smi.
 */

import { execSync } from "node:child_process";
import type { GpuProfile } from "./gpu-tier-profiles.js";
import { getGpuProfile, selectBestProfile } from "./gpu-tier-profiles.js";

/** Raw data extracted from nvidia-smi for a single GPU. */
export interface DetectedGpu {
  /** Marketing name as reported by nvidia-smi, e.g. `"NVIDIA GeForce RTX 4090"`. */
  name: string;
  /** Total VRAM in MiB (as reported by `memory.total`). */
  vram_mb: number;
  /**
   * CUDA compute capability in dotted form, e.g. `"8.9"`.
   * `null` when nvidia-smi does not report `compute_cap` (older drivers).
   */
  cuda_compute: string | null;
}

/**
 * Query the first detected NVIDIA GPU via `nvidia-smi`.
 *
 * Runs:
 * ```
 * nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits
 * ```
 *
 * Parses the first output line. Returns `null` on any failure:
 *   - nvidia-smi not found in PATH
 *   - non-zero exit code (no NVIDIA driver / no GPU)
 *   - unexpected output format
 *   - any other exception
 *
 * The 2-second timeout prevents hangs in headless / CI environments.
 */
export function detectNvidiaGpu(): DetectedGpu | null {
  try {
    const raw = execSync(
      "nvidia-smi --query-gpu=name,memory.total,compute_cap --format=csv,noheader,nounits",
      { encoding: "utf8", timeout: 2_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (!firstLine) return null;

    // Format: "<name>, <memory_total_mib>, <compute_cap>"
    // The name may contain commas (rare but possible), so split from the
    // right to keep the name intact.
    const parts = firstLine.split(",");
    if (parts.length < 3) return null;

    // Last two parts are the numeric fields; everything before is the name.
    const computeRaw = parts[parts.length - 1]?.trim() ?? "";
    const memRaw = parts[parts.length - 2]?.trim() ?? "";
    const name = parts
      .slice(0, parts.length - 2)
      .join(",")
      .trim();

    if (!name) return null;

    const vram_mb = parseInt(memRaw, 10);
    if (isNaN(vram_mb) || vram_mb <= 0) return null;

    // compute_cap may be "N/A" on very old drivers.
    const cuda_compute =
      computeRaw.length > 0 && computeRaw !== "N/A" ? computeRaw : null;

    return { name, vram_mb, cuda_compute };
  } catch {
    // nvidia-smi not found, timed out, or any other error.
    return null;
  }
}

/**
 * Auto-select the best GPU tier profile for the host.
 *
 * Resolution order:
 *   1. If `ELIZA_GPU_PROFILE` is set, return that profile (or `null` if
 *      the id is unrecognised).
 *   2. Otherwise, run `detectNvidiaGpu()` and call `selectBestProfile`.
 *   3. Return `null` when no GPU is detected or no profile fits.
 *
 * Never throws.
 */
export function autoSelectProfile(): GpuProfile | null {
  const envOverride = process.env["ELIZA_GPU_PROFILE"];
  if (envOverride) {
    return getGpuProfile(envOverride);
  }

  const gpu = detectNvidiaGpu();
  if (!gpu) return null;

  const vramGb = gpu.vram_mb / 1024;
  const cudaCompute = gpu.cuda_compute ?? "0.0";
  return selectBestProfile(vramGb, cudaCompute);
}
