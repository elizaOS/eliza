/**
 * Simplified per-GPU configuration profiles for the Eliza-1 model family.
 *
 * These profiles describe hardware capabilities and llama-server flag
 * recommendations for four supported NVIDIA cards. They are intentionally
 * separate from the richer YAML-backed `GpuYamlProfile` system in
 * `gpu-profile-loader.ts` — the JSON-style data here is bundled inline
 * (no fs reads, no YAML parser) so it is safe in every environment:
 * mobile runtimes, edge bundles, and server contexts.
 *
 * Selection: use `selectBestProfile(vramGb, cudaCompute)` to pick the
 * most capable profile the detected GPU qualifies for. The result feeds
 * `buildLlamaCppArgs()` to produce a ready-to-use argv array for
 * llama-server. Caller must fill in `--model <path>` separately — this
 * module never references model files.
 *
 * Override: set `ELIZA_GPU_PROFILE=<id>` (e.g. `rtx-4090`) to bypass
 * auto-detection and force a specific profile. `autoSelectProfile()` in
 * `detect.ts` respects this variable.
 *
 * Supported ids: `rtx-3090`, `rtx-4090`, `rtx-5090`, `h200`.
 */

/** GPU feature flags that affect quantisation and kernel availability. */
export type GpuFeature = "fp16" | "bf16" | "int8" | "int4" | "fp8" | "fp4";

/** Simplified GPU profile — JSON-safe, bundle-friendly. */
export interface GpuProfile {
  /** Canonical profile id, e.g. `"rtx-4090"`. */
  id: string;
  /** Human-readable card name shown to the user. */
  display_name: string;
  /** Total VRAM in GiB. */
  vram_gb: number;
  /**
   * CUDA compute capability as a dotted version string, e.g. `"8.9"`.
   * Used for numeric comparison in `selectBestProfile`.
   */
  cuda_compute: string;
  /** Quantisation / precision features the GPU supports. */
  features: GpuFeature[];
  /** Recommended Eliza-1 tier ids for common workloads. */
  recommended_tiers: {
    primary: string | null;
    secondary: string | null;
    heavy: string | null;
  };
  /** llama-server flags for this card. */
  llama_cpp_flags: {
    n_gpu_layers: number;
    tensor_split: number[] | null;
    flash_attn: boolean;
    use_mmap: boolean;
    numa: boolean;
  };
  /** DFlash speculative-decoding settings. */
  dflash: {
    enabled: boolean;
    drafter_tier: string;
    speculative_window: number;
  };
  /** Maximum recommended context window in tokens. */
  ctx_size_tokens: number;
  /** Free-text notes for operators / documentation. */
  notes: string;
}

// ---------------------------------------------------------------------------
// Inline profile data — no fs reads at runtime
// ---------------------------------------------------------------------------

const RTX_3090: GpuProfile = {
  id: "rtx-3090",
  display_name: "NVIDIA RTX 3090",
  vram_gb: 24,
  cuda_compute: "8.6",
  features: ["fp16", "bf16", "int8", "int4"],
  recommended_tiers: {
    primary: "7b-q4",
    secondary: "3b-q8",
    heavy: null,
  },
  llama_cpp_flags: {
    n_gpu_layers: 99,
    tensor_split: null,
    flash_attn: true,
    use_mmap: true,
    numa: false,
  },
  dflash: {
    enabled: true,
    drafter_tier: "0_8b",
    speculative_window: 5,
  },
  ctx_size_tokens: 32768,
  notes:
    "24 GB GDDR6X. Comfortably fits 7B Q4_K_M with context. Use 3B Q8 for highest quality in 24 GB. DFlash enabled with 0.8B drafter.",
};

const RTX_4090: GpuProfile = {
  id: "rtx-4090",
  display_name: "NVIDIA RTX 4090",
  vram_gb: 24,
  cuda_compute: "8.9",
  features: ["fp16", "bf16", "int8", "int4", "fp8"],
  recommended_tiers: {
    primary: "7b-q8",
    secondary: "14b-q4",
    heavy: null,
  },
  llama_cpp_flags: {
    n_gpu_layers: 99,
    tensor_split: null,
    flash_attn: true,
    use_mmap: true,
    numa: false,
  },
  dflash: {
    enabled: true,
    drafter_tier: "0_8b",
    speculative_window: 6,
  },
  ctx_size_tokens: 65536,
  notes:
    "24 GB GDDR6X, Ada Lovelace. FP8 available. Fits 7B Q8 fully; 14B Q4 with KV cache compression. Higher memory bandwidth than 3090.",
};

const RTX_5090: GpuProfile = {
  id: "rtx-5090",
  display_name: "NVIDIA RTX 5090",
  vram_gb: 32,
  cuda_compute: "12.0",
  features: ["fp16", "bf16", "int8", "int4", "fp8", "fp4"],
  recommended_tiers: {
    primary: "14b-q8",
    secondary: "27b-q4",
    heavy: "27b-q8",
  },
  llama_cpp_flags: {
    n_gpu_layers: 99,
    tensor_split: null,
    flash_attn: true,
    use_mmap: true,
    numa: false,
  },
  dflash: {
    enabled: true,
    drafter_tier: "2b",
    speculative_window: 8,
  },
  ctx_size_tokens: 131072,
  notes:
    "32 GB GDDR7, Blackwell. FP4 available. First consumer card to fit 27B at Q4. Native FP4 acceleration for speculative decoding.",
};

const H200: GpuProfile = {
  id: "h200",
  display_name: "NVIDIA H200",
  vram_gb: 141,
  cuda_compute: "9.0",
  features: ["fp16", "bf16", "int8", "int4", "fp8"],
  recommended_tiers: {
    primary: "27b-q8",
    secondary: "27b-f16",
    heavy: "27b-256k",
  },
  llama_cpp_flags: {
    n_gpu_layers: 99,
    tensor_split: null,
    flash_attn: true,
    use_mmap: false,
    numa: true,
  },
  dflash: {
    enabled: true,
    drafter_tier: "2b",
    speculative_window: 10,
  },
  ctx_size_tokens: 262144,
  notes:
    "141 GB HBM3e. SXM5 form factor. Fits 27B at full F16. NUMA-aware for multi-socket SXM. DFlash with 2B drafter for high throughput.",
};

// ---------------------------------------------------------------------------
// Public registry
// ---------------------------------------------------------------------------

/**
 * All built-in profiles keyed by id.
 *
 * Data is inlined — no fs reads at runtime — so the map is available in
 * every environment (mobile, edge, server) without extra IO.
 */
export const GPU_PROFILES: Record<string, GpuProfile> = {
  "rtx-3090": RTX_3090,
  "rtx-4090": RTX_4090,
  "rtx-5090": RTX_5090,
  h200: H200,
};

/**
 * Look up a profile by its canonical id. Returns `null` when the id is
 * not in the built-in registry (including when the caller passes an
 * unrecognised override id from `ELIZA_GPU_PROFILE`).
 */
export function getGpuProfile(id: string): GpuProfile | null {
  return GPU_PROFILES[id] ?? null;
}

// ---------------------------------------------------------------------------
// Compute-capability comparison helpers
// ---------------------------------------------------------------------------

/**
 * Parse a dotted compute-capability string (`"8.9"`) to a single
 * comparable float. Handles both `"8.9"` and `"sm_89"` spellings.
 */
function parseCudaCompute(cc: string): number {
  // Strip optional "sm_" prefix used by some tools.
  const cleaned = cc.replace(/^sm_/i, "").replace("_", ".");
  const val = parseFloat(cleaned);
  return isNaN(val) ? -1 : val;
}

/**
 * Return the best-fit profile for a detected GPU.
 *
 * "Best fit" = the profile with the highest `vram_gb` that still
 * satisfies both of:
 *   1. `profile.vram_gb <= vramGb`   (card has at least as much VRAM)
 *   2. `profile.cuda_compute <= cudaCompute`  (card meets compute level)
 *
 * Returns `null` when no profile fits (e.g. only 8 GB VRAM — below all
 * supported cards).
 */
export function selectBestProfile(
  vramGb: number,
  cudaCompute: string,
): GpuProfile | null {
  const hostCc = parseCudaCompute(cudaCompute);

  let best: GpuProfile | null = null;
  let bestCc = -1;
  for (const profile of Object.values(GPU_PROFILES)) {
    const profileCc = parseCudaCompute(profile.cuda_compute);
    if (profile.vram_gb > vramGb) continue;
    if (profileCc > hostCc) continue;
    if (
      best === null ||
      profile.vram_gb > best.vram_gb ||
      (profile.vram_gb === best.vram_gb && profileCc > bestCc)
    ) {
      best = profile;
      bestCc = profileCc;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// CLI-flag builder
// ---------------------------------------------------------------------------

/**
 * Produce a `llama-server` argv array from a profile.
 *
 * Flags produced (in order):
 *   --n-gpu-layers <N>
 *   --flash-attn             (when flash_attn is true)
 *   --no-mmap                (when use_mmap is false)
 *   --numa                   (when numa is true)
 *   --ctx-size <N>
 *
 * Any value in `overrides` replaces the corresponding profile field
 * before the flags are built — useful for per-call adjustments without
 * modifying the shared profile object.
 *
 * Note: `--model <path>` is intentionally omitted. Callers must append
 * it themselves so this function never needs to touch model files.
 */
export function buildLlamaCppArgs(
  profile: GpuProfile,
  overrides?: Partial<GpuProfile["llama_cpp_flags"]> & {
    ctx_size_tokens?: number;
  },
): string[] {
  const flags = overrides
    ? { ...profile.llama_cpp_flags, ...overrides }
    : profile.llama_cpp_flags;
  const ctxSize = overrides?.ctx_size_tokens ?? profile.ctx_size_tokens;

  const argv: string[] = [];

  argv.push("--n-gpu-layers", String(flags.n_gpu_layers));

  if (flags.flash_attn) {
    argv.push("--flash-attn");
  }

  if (!flags.use_mmap) {
    argv.push("--no-mmap");
  }

  if (flags.numa) {
    argv.push("--numa");
  }

  argv.push("--ctx-size", String(ctxSize));

  return argv;
}
