/**
 * Eliza-1 model resolver.
 *
 * Given the user's `MILADY_MODEL` env value (one of `eliza-1-2b`,
 * `eliza-1-9b`, `eliza-1-27b`) and a hardware probe, return the concrete
 * HuggingFace repo id, quantization flavor, and recommended runtime
 * backend (ollama vs. vLLM).
 *
 * This file is a pure helper. It does NOT touch the local-inference
 * registry or the downloader; the caller (currently the dev orchestrator
 * and the local-ai handler) is responsible for invoking
 * `ensureInstalled` / `autoAssignAtBoot` once the resolver returns.
 *
 * Source of truth:
 *   - sizes + quant siblings: `training/scripts/training/model_registry.py`
 *   - vLLM target shapes:    `training/scripts/inference/serve_vllm.py`
 *
 * The mapping below mirrors the Python registry. If we add a fourth
 * eliza-1 size, both this file and `model_registry.py` must change in
 * lockstep.
 */
import type { HardwareProbe } from "../services/local-inference/types";

export type ElizaOneSize = "eliza-1-2b" | "eliza-1-9b" | "eliza-1-27b";

/** Quant flavors published per size. Mirrors `quantization_after` in
 *  `training/scripts/training/model_registry.py`. */
export type QuantFlavor =
  | "bf16"
  | "polarquant"
  | "gguf-q4_k_m"
  | "fp8";

/** Recommended runtime that should host the chosen quant. The local-AI
 *  loader uses this hint to either start ollama or to launch the vLLM
 *  serve script. */
export type LocalBackend =
  | "ollama"          // gguf-q4_k_m — llama.cpp / ollama
  | "vllm-bf16"       // bf16 weights — datacenter Hopper full-precision
  | "vllm-fp8"        // fp8 weights — sm_90+ servers
  | "vllm-polarquant" // 4-bit W via the vLLM PolarQuant plugin
  | "cpu-gguf";       // gguf-q4_k_m on CPU only — fallback when no GPU

/** Per-size canonical metadata. The base `repoId` is the fp16/bf16
 *  release; quant siblings live at `${repoId}-${suffix}` (matching the
 *  HF naming convention used by `push_model_to_hf.py`). */
export interface SizeSpec {
  /** Base HF repo id (bf16). */
  baseRepoId: string;
  /** GGUF sibling repo id. */
  ggufRepoId: string;
  /** PolarQuant sibling repo id. */
  polarQuantRepoId: string;
  /** FP8 sibling repo id (only published for 27B today). */
  fp8RepoId: string | null;
  /** GGUF Q4_K_M filename inside `ggufRepoId`. */
  ggufFile: string;
  /** Approximate VRAM footprint of Q4_K_M weights + 32k KV. Used to
   *  rule out sizes the host genuinely can't run. */
  q4kmFootprintGb: number;
  /** Approximate VRAM footprint of bf16 weights + 32k KV. */
  bf16FootprintGb: number;
}

export const SIZE_SPECS: Record<ElizaOneSize, SizeSpec> = {
  "eliza-1-2b": {
    baseRepoId: "elizaos/eliza-1-2b",
    ggufRepoId: "elizaos/eliza-1-2b-gguf",
    polarQuantRepoId: "elizaos/eliza-1-2b-polarquant",
    fp8RepoId: null,
    ggufFile: "eliza-1-2b-Q4_K_M.gguf",
    q4kmFootprintGb: 2,
    bf16FootprintGb: 6,
  },
  "eliza-1-9b": {
    baseRepoId: "elizaos/eliza-1-9b",
    ggufRepoId: "elizaos/eliza-1-9b-gguf",
    polarQuantRepoId: "elizaos/eliza-1-9b-polarquant",
    fp8RepoId: null,
    ggufFile: "eliza-1-9b-Q4_K_M.gguf",
    q4kmFootprintGb: 7,
    bf16FootprintGb: 22,
  },
  "eliza-1-27b": {
    baseRepoId: "elizaos/eliza-1-27b",
    ggufRepoId: "elizaos/eliza-1-27b-gguf",
    polarQuantRepoId: "elizaos/eliza-1-27b-polarquant",
    fp8RepoId: "elizaos/eliza-1-27b-fp8",
    ggufFile: "eliza-1-27b-Q4_K_M.gguf",
    q4kmFootprintGb: 18,
    bf16FootprintGb: 60,
  },
};

export interface ResolvedElizaOneModel {
  size: ElizaOneSize;
  /** HF repo id of the *quant variant* the host should pull. */
  repoId: string;
  /** Filename to pull from `repoId` (for GGUF quants). */
  ggufFile: string | null;
  quant: QuantFlavor;
  backend: LocalBackend;
  /** Human-readable rationale, surfaced in onboarding logs. */
  reason: string;
}

const VALID_SIZES: ReadonlySet<string> = new Set([
  "eliza-1-2b",
  "eliza-1-9b",
  "eliza-1-27b",
]);

export function isElizaOneSize(value: string): value is ElizaOneSize {
  return VALID_SIZES.has(value);
}

/** Effective VRAM in GB for sizing decisions. On Apple Silicon we use
 *  total system RAM (unified memory); on x86 + discrete GPU we use VRAM.
 *  Mirrors the heuristic in `services/local-inference/hardware.ts`. */
function effectiveVramGb(probe: HardwareProbe): number {
  if (probe.appleSilicon) return probe.totalRamGb;
  if (probe.gpu) return probe.gpu.totalVramGb;
  return 0;
}

function isHopperOrBlackwellDatacenter(probe: HardwareProbe): boolean {
  // VRAM shape we use as a stand-in for sm_90+ datacenter parts. CUDA
  // capability detection lives in node-llama-cpp, which doesn't expose
  // it; the 70 GB threshold reliably catches H100 (80), H200 (141),
  // B200 (192) without false-positives on consumer Blackwell (≤32 GB).
  return Boolean(probe.gpu && probe.gpu.totalVramGb >= 70);
}

/**
 * Pick the right quant + backend for a given size and host.
 *
 * Returns `null` when the host genuinely can't run the requested size
 * even with the smallest quant. The caller is expected to surface that
 * to the user (probably by suggesting `eliza-1-2b` instead).
 */
export function resolveElizaOneModel(
  size: ElizaOneSize,
  probe: HardwareProbe,
): ResolvedElizaOneModel | null {
  const spec = SIZE_SPECS[size];
  const vram = effectiveVramGb(probe);

  // Datacenter Hopper / Blackwell — full precision, no quant overhead.
  if (isHopperOrBlackwellDatacenter(probe) && vram >= spec.bf16FootprintGb) {
    if (spec.fp8RepoId) {
      return {
        size,
        repoId: spec.fp8RepoId,
        ggufFile: null,
        quant: "fp8",
        backend: "vllm-fp8",
        reason: `Datacenter GPU (${vram} GB VRAM) — fp8 weights via vLLM`,
      };
    }
    return {
      size,
      repoId: spec.baseRepoId,
      ggufFile: null,
      quant: "bf16",
      backend: "vllm-bf16",
      reason: `Datacenter GPU (${vram} GB VRAM) — bf16 weights via vLLM`,
    };
  }

  // Workstation Blackwell / Ampere with 24-48 GB. PolarQuant 4-bit weights
  // give the best PPL/throughput trade in this band.
  if (vram >= 24 && vram >= spec.q4kmFootprintGb * 1.5) {
    return {
      size,
      repoId: spec.polarQuantRepoId,
      ggufFile: null,
      quant: "polarquant",
      backend: "vllm-polarquant",
      reason: `Workstation GPU (${vram} GB VRAM) — PolarQuant 4-bit via vLLM`,
    };
  }

  // Consumer GPU (16-24 GB) or smaller — GGUF Q4_K_M via ollama / llama.cpp.
  if (vram >= spec.q4kmFootprintGb || probe.appleSilicon) {
    return {
      size,
      repoId: spec.ggufRepoId,
      ggufFile: spec.ggufFile,
      quant: "gguf-q4_k_m",
      backend: "ollama",
      reason: probe.appleSilicon
        ? `Apple Silicon (${probe.totalRamGb} GB unified) — GGUF Q4_K_M via llama.cpp`
        : `Consumer GPU (${vram} GB VRAM) — GGUF Q4_K_M via ollama`,
    };
  }

  // CPU-only fallback. Only viable for the 2B size in practice; the
  // 9B and 27B will return null because q4kmFootprintGb > totalRamGb / 2
  // on any reasonable laptop. We still allow it if total RAM is enough.
  if (probe.totalRamGb >= spec.q4kmFootprintGb * 1.5) {
    return {
      size,
      repoId: spec.ggufRepoId,
      ggufFile: spec.ggufFile,
      quant: "gguf-q4_k_m",
      backend: "cpu-gguf",
      reason: `CPU-only host (${probe.totalRamGb} GB RAM) — GGUF Q4_K_M, expect ~5-15 tok/s`,
    };
  }

  return null;
}

/**
 * Convenience: read the `MILADY_MODEL` env var, validate it, and call
 * `resolveElizaOneModel`. Returns `null` if the env var is unset or the
 * value isn't one of the three published sizes.
 */
export function resolveElizaOneFromEnv(
  envValue: string | undefined,
  probe: HardwareProbe,
): ResolvedElizaOneModel | null {
  const raw = envValue?.trim().toLowerCase();
  if (!raw) return null;
  if (!isElizaOneSize(raw)) return null;
  return resolveElizaOneModel(raw, probe);
}

/**
 * Returns the next-smaller size from `size`, or null if `size` is the
 * smallest. Used by callers that want to fall back when the host can't
 * run the requested size.
 */
export function smallerElizaOneSize(size: ElizaOneSize): ElizaOneSize | null {
  switch (size) {
    case "eliza-1-27b":
      return "eliza-1-9b";
    case "eliza-1-9b":
      return "eliza-1-2b";
    case "eliza-1-2b":
      return null;
  }
}

/** Public list of sizes — exported so callers (CLI, settings UI) can
 *  enumerate the published lineup without duplicating it. */
export const ELIZA_ONE_SIZES: readonly ElizaOneSize[] = [
  "eliza-1-2b",
  "eliza-1-9b",
  "eliza-1-27b",
];
