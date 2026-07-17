/**
 * Device-fit selector for the one forced local model (eliza-1).
 *
 * The product rule (see `packages/ui/docs/local-model-simplification/README.md`):
 * **always run the biggest eliza-1 tier we can, balanced against a 128k context
 * target, with every memory optimization applied** so the floors are as low as
 * physics allows:
 *
 *  - **TurboQuant weights** — the catalog `sizeGb` per tier already reflects the
 *    TurboQuant-compressed GGUF (e.g. a 2B model is 1.4 GB, not ~4 GB bf16).
 *  - **Stock q8_0 KV-cache** — Gemma 4's KV is already minimal by construction
 *    (MQA = 1 KV head, windowed sliding-window attention on most layers, and
 *    shared-KV layers reusing earlier KV), so a 128k window fits in a fraction
 *    of a GB at stock q8_0 without the legacy QJL/Polar kernels. The head_dim=128
 *    QJL kernel does not apply to Gemma's dual head dims (512 global / 256 swa)
 *    and is not used. KV quant is forced, never a user option.
 *
 * `minRamGb` per tier is therefore "TurboQuant weights + a 128k q8_0 KV cache +
 * runtime/OS overhead". Picking the largest tier whose `minRamGb` fits free RAM
 * is exactly "biggest model that still gets a 128k window".
 *
 * **Dynamic fit-to-RAM context (#8809 M10b).** Picking the largest tier whose
 * static `minRamGb` floor fits is the coarse gate. On top of that we compute the
 * *largest context window that actually fits the device's free RAM* for the
 * chosen tier, from the per-token q8_0 KV rate (`kvBytesPerTokenForTier`) rather
 * than only honouring the catalog ceiling. On a roomy host that is the tier's
 * native window; on a host that clears the weights+overhead floor but not a full
 * 128k cache, the window shrinks to the largest 4k-stepped size that fits. The
 * tier choice never drops below 2B (0.8B is gone); when even a minimum window
 * (`ELIZA_1_MIN_LOCAL_CONTEXT`) cannot fit any tier, we return `null`, which the
 * caller reads as "this modality should route to Cloud" (the AUTO policy).
 */

import type { Eliza1TierId } from "./catalog";
import { MODEL_CATALOG } from "./catalog";
import type { CatalogModel } from "./types";

/** The KV-cache quantization eliza-1 always uses on-device. Gemma 4's KV is
 * already minimal (MQA + windowed-SWA + shared-KV), so stock q8_0 is sufficient;
 * the legacy head_dim=128 QJL kernel is incompatible with Gemma's dual head dims
 * (512 global / 256 swa) and is not used. */
export const ELIZA_1_KV_QUANT = "q8_0" as const;

/** The consumer context target. We never advertise less than this if it fits. */
export const ELIZA_1_CONTEXT_TARGET = 131072; // 128k

/** Floor below which a cramped local window is worse than routing to Cloud. */
export const ELIZA_1_MIN_LOCAL_CONTEXT = 8192; // 8k

/** Round a token count down to a 4k step so we advertise clean window sizes. */
const CONTEXT_STEP = 4096;

/**
 * Fixed non-KV cost on top of the TurboQuant weights: the inference runtime,
 * activation scratch, and OS headroom. Used by the context-fit math to reserve
 * room before the KV cache claims the rest of free RAM.
 */
const RUNTIME_OVERHEAD_GB = 1.0;

const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * Per-token q8_0 KV footprint for a tier, derived from the catalog's own
 * sizing: the tier's `minRamGb` floor is "TurboQuant weights + a native-window
 * q8_0 KV cache + runtime/OS overhead", so the RAM the catalog reserves for the
 * KV cache at the native window is `minRamGb − sizeGb − RUNTIME_OVERHEAD_GB`,
 * and dividing by the native context gives the per-token rate. Deriving it from
 * the catalog (rather than a second hardcoded table) keeps the full-fit floor
 * and the dynamic context-downscale math provably consistent: just below a
 * tier's floor, exactly less-than-native fits.
 *
 * Returns `null` when the tier's floor doesn't actually reserve any KV room
 * (mis-sized catalog row) — the caller then cannot compute a window for it.
 */
function kvBytesPerTokenForTier(tier: CatalogModel): number | null {
  const { minRamGb, sizeGb, contextLength } = tier;
  if (minRamGb == null || sizeGb == null || contextLength == null) return null;
  const kvReserveGb = minRamGb - sizeGb - RUNTIME_OVERHEAD_GB;
  if (kvReserveGb <= 0 || contextLength <= 0) return null;
  return (kvReserveGb * BYTES_PER_GB) / contextLength;
}

function roundDownToStep(tokens: number, step = CONTEXT_STEP): number {
  return Math.max(0, Math.floor(tokens / step) * step);
}

export interface Eliza1Fit {
  /** The chosen tier (always the largest that fits the policy). */
  tierId: Eliza1TierId;
  /** The context window to load — native target when it fits, else downscaled. */
  contextLength: number;
  /** The KV quant to load with (stock q8_0 on-device — Gemma KV is already minimal). */
  kvQuant: typeof ELIZA_1_KV_QUANT;
  /** True when context was reduced below the tier's native window to fit RAM. */
  contextDownscaled: boolean;
  /** Per-token q8_0 KV footprint used to compute the window (bytes). */
  kvBytesPerToken: number;
  /**
   * The largest 4k-stepped window that fits free RAM for this tier at the q8_0
   * KV rate, before clamping to the tier's native ceiling. Equals
   * `contextLength` once clamped on roomy hosts; larger than `contextLength`
   * only when free RAM could hold more than the tier's native window.
   */
  maxFittingContext: number;
  /** Why this tier — surfaced in diagnostics, never as a user control. */
  reason: "native-fit" | "context-downscaled";
}

/**
 * Largest 4k-stepped window that fits `freeRamGb` for `tier` at the q8_0 KV
 * rate. Returns `context: 0` when the weights+overhead alone do not fit, or
 * when the tier's KV rate cannot be derived (caller treats either as "this
 * tier cannot hold any window").
 */
function maxFittingContextForTier(
  tier: CatalogModel,
  freeRamGb: number,
): { context: number; kvBytesPerToken: number } | null {
  const kvBytesPerToken = kvBytesPerTokenForTier(tier);
  if (kvBytesPerToken == null) return null;
  const sizeGb = tier.sizeGb;
  const kvAvailableGb = freeRamGb - sizeGb - RUNTIME_OVERHEAD_GB;
  if (kvAvailableGb <= 0) return { context: 0, kvBytesPerToken };
  const tokensThatFit = (kvAvailableGb * BYTES_PER_GB) / kvBytesPerToken;
  return { context: roundDownToStep(tokensThatFit), kvBytesPerToken };
}

/**
 * Pick the best on-device eliza-1 configuration for a device with `freeRamGb` of
 * usable RAM (Apple-silicon unified RAM, discrete-GPU VRAM, or CPU RAM — the
 * caller normalizes this, e.g. via the device-tier classifier).
 *
 * Returns `null` when nothing acceptable fits locally → the caller routes this
 * modality to Cloud (AUTO). Never returns a tier smaller than 2B (0.8B is gone).
 */
export function selectBestEliza1Fit(freeRamGb: number): Eliza1Fit | null {
  if (!Number.isFinite(freeRamGb) || freeRamGb <= 0) return null;

  // Release tiers, largest RAM-floor first. The floor already bakes in a native
  // (128k) q8_0 window, so the first one whose floor fits is the biggest model
  // that still gets its full window.
  const tiers = [...MODEL_CATALOG]
    .filter(
      (m) => typeof m.minRamGb === "number" && typeof m.sizeGb === "number",
    )
    .sort((a, b) => b.minRamGb - a.minRamGb);

  for (const tier of tiers) {
    if (tier.minRamGb == null || freeRamGb < tier.minRamGb) continue;
    const nativeCtx = tier.contextLength ?? ELIZA_1_CONTEXT_TARGET;
    const fit = maxFittingContextForTier(tier, freeRamGb);
    if (!fit) continue;
    const { context: maxFittingContext, kvBytesPerToken } = fit;
    // Floor fits → at least the native window fits; clamp the dynamic window to
    // the tier ceiling so we never advertise more than the bundle ships.
    const contextLength = Math.min(
      Math.max(maxFittingContext, nativeCtx),
      nativeCtx,
    );
    return {
      tierId: tier.id as Eliza1TierId,
      contextLength,
      kvQuant: ELIZA_1_KV_QUANT,
      contextDownscaled: false,
      kvBytesPerToken,
      maxFittingContext,
      reason: "native-fit",
    };
  }

  // No tier clears its native floor. Keep the smallest tier (2B) and shrink the
  // q8_0 KV window to the largest 4k step that fits. Never drop below 2B.
  const smallest = tiers[tiers.length - 1];
  if (!smallest || smallest.contextLength == null) return null;
  const nativeCtx = smallest.contextLength;
  const fit = maxFittingContextForTier(smallest, freeRamGb);
  if (!fit) return null;
  const { context: fittedContext, kvBytesPerToken } = fit;
  if (fittedContext < ELIZA_1_MIN_LOCAL_CONTEXT) return null; // too cramped → Cloud

  const contextLength = Math.min(fittedContext, nativeCtx);
  return {
    tierId: smallest.id as Eliza1TierId,
    contextLength,
    kvQuant: ELIZA_1_KV_QUANT,
    contextDownscaled: contextLength < nativeCtx,
    kvBytesPerToken,
    maxFittingContext: fittedContext,
    reason: contextLength < nativeCtx ? "context-downscaled" : "native-fit",
  };
}
