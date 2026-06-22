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
 *  - **QJL KV-cache** — `qjl1_256` (the head_dim=256 QJL variant eliza-1 uses):
 *    ~1 bit/coordinate + a bf16 norm, which is what makes a 128k window fit in a
 *    fraction of a GB on the small tiers. It is the *forced* KV quant, never an
 *    option the user picks.
 *
 * `minRamGb` per tier is therefore "TurboQuant weights + a 128k QJL KV cache +
 * runtime/OS overhead". Picking the largest tier whose `minRamGb` fits free RAM
 * is exactly "biggest model that still gets a 128k window".
 *
 * When even the smallest tier (2B) cannot reach 128k on this device, we keep the
 * 2B model and shrink the *context* (QJL KV scales ~linearly with tokens) down to
 * the largest window that fits — never falling back to a smaller/0.8B model. If
 * not even a minimum window fits, we return `null`, which the caller reads as
 * "this modality should route to Cloud" (the AUTO policy).
 */

import { MODEL_CATALOG } from "./catalog";
import type { Eliza1TierId } from "./catalog";

/** The KV-cache quantization eliza-1 always uses on-device (head_dim=256 QJL). */
export const ELIZA_1_KV_QUANT = "qjl1_256" as const;

/** The consumer context target. We never advertise less than this if it fits. */
export const ELIZA_1_CONTEXT_TARGET = 131072; // 128k

/** Floor below which a cramped local window is worse than routing to Cloud. */
export const ELIZA_1_MIN_LOCAL_CONTEXT = 8192; // 8k

/**
 * Fixed non-KV cost on top of the TurboQuant weights: the inference runtime,
 * activation scratch, and OS headroom. Used only for the context-downscale math
 * on the smallest tier; the full-fit path trusts the catalog `minRamGb` directly.
 */
const RUNTIME_OVERHEAD_GB = 1.0;

/** Round a token count down to a 4k step so we advertise clean window sizes. */
function roundDownToStep(tokens: number, step = 4096): number {
  return Math.max(0, Math.floor(tokens / step) * step);
}

export interface Eliza1Fit {
  /** The chosen tier (always the largest that fits the policy). */
  tierId: Eliza1TierId;
  /** The context window to load — native target when it fits, else downscaled. */
  contextLength: number;
  /** The KV quant to load with (always QJL on-device). */
  kvQuant: typeof ELIZA_1_KV_QUANT;
  /** True when context was reduced below the tier's native window to fit RAM. */
  contextDownscaled: boolean;
  /** Why this tier — surfaced in diagnostics, never as a user control. */
  reason: "native-fit" | "context-downscaled";
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
  // (≥128k) QJL window, so the first one that fits is the biggest model that
  // still gets its full window.
  const tiers = [...MODEL_CATALOG]
    .filter((m) => typeof m.minRamGb === "number" && typeof m.sizeGb === "number")
    .sort((a, b) => b.minRamGb - a.minRamGb);

  for (const tier of tiers) {
    if (tier.minRamGb != null && freeRamGb >= tier.minRamGb) {
      return {
        tierId: tier.id as Eliza1TierId,
        contextLength: tier.contextLength ?? ELIZA_1_CONTEXT_TARGET,
        kvQuant: ELIZA_1_KV_QUANT,
        contextDownscaled: false,
        reason: "native-fit",
      };
    }
  }

  // Nothing fits at its native window. Keep the smallest tier (2B) and shrink the
  // QJL KV window to the largest that fits. Never drop below 2B.
  const smallest = tiers[tiers.length - 1];
  if (!smallest) return null;
  const { minRamGb, sizeGb, contextLength } = smallest;
  if (minRamGb == null || sizeGb == null || contextLength == null) return null;

  const kvAt128k = minRamGb - sizeGb - RUNTIME_OVERHEAD_GB; // GB for a 128k QJL KV
  const kvAvailable = freeRamGb - sizeGb - RUNTIME_OVERHEAD_GB;
  if (kvAt128k <= 0 || kvAvailable <= 0) return null; // can't even hold weights

  const fittedContext = roundDownToStep(
    ELIZA_1_CONTEXT_TARGET * (kvAvailable / kvAt128k),
  );
  if (fittedContext < ELIZA_1_MIN_LOCAL_CONTEXT) return null; // too cramped → Cloud

  return {
    tierId: smallest.id as Eliza1TierId,
    contextLength: Math.min(fittedContext, contextLength),
    kvQuant: ELIZA_1_KV_QUANT,
    contextDownscaled: fittedContext < contextLength,
    reason: "context-downscaled",
  };
}
