/**
 * Singing-model codepath. Loads the ModelsLab/omnivoice-singing GGUF
 * (or whichever path the user specified via OMNIVOICE_SINGING_MODEL_PATH)
 * as a separate OmnivoiceContext instance, since omnivoice's API is
 * single-model-per-context.
 *
 * The context is created lazily on first request and kept alive for the
 * lifetime of the plugin process — model load is the dominant cost
 * (~1–3s for Q8_0) and we don't want to pay it per utterance.
 */

import { OmnivoiceContext } from "./ffi";
import { runSynthesis } from "./synth";
import type {
  OmnivoiceSynthesisResult,
  OmnivoiceSynthesizeOptions,
} from "./types";

interface SingingOptions {
  modelPath: string;
  codecPath: string;
  useFa?: boolean;
  clampFp16?: boolean;
}

let cached: { key: string; ctx: OmnivoiceContext } | null = null;

function cacheKey(opts: SingingOptions): string {
  return [
    opts.modelPath,
    opts.codecPath,
    opts.useFa ?? "",
    opts.clampFp16 ?? "",
  ].join("|");
}

export async function getSingingContext(
  opts: SingingOptions,
): Promise<OmnivoiceContext> {
  const key = cacheKey(opts);
  if (cached && cached.key === key) return cached.ctx;
  if (cached) cached.ctx.close();
  const ctx = await OmnivoiceContext.open({
    modelPath: opts.modelPath,
    codecPath: opts.codecPath,
    useFa: opts.useFa,
    clampFp16: opts.clampFp16,
  });
  cached = { key, ctx };
  return ctx;
}

/**
 * Run synthesis against the singing model. Defaults a longer chunk
 * window since singing prompts are typically longer than speech and
 * less tolerant of mid-phrase chunk seams.
 */
export async function runSingingSynthesis(
  ctx: OmnivoiceContext,
  opts: OmnivoiceSynthesizeOptions,
): Promise<OmnivoiceSynthesisResult> {
  const merged: OmnivoiceSynthesizeOptions = {
    ...opts,
    chunkDurationSec: opts.chunkDurationSec ?? 30,
    chunkThresholdSec: opts.chunkThresholdSec ?? 60,
  };
  return runSynthesis(ctx, merged);
}

/** Test-only — clear the cached singing context. */
export function _resetSingingCache(): void {
  if (cached) {
    cached.ctx.close();
    cached = null;
  }
}
