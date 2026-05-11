/**
 * CPU-offloaded KV-cache spill policy.
 *
 * packages/inference/AGENTS.md §3 item 7 mandates that for context > 64k on a
 * device whose RAM cannot hold the full KV cache, the runtime MUST implement
 * *spill* — keep the hot KV pages resident, page the cold ones out to CPU RAM
 * (or, when even that is insufficient, to disk) — rather than refusing the
 * request. AGENTS.md §3 "Failure handling" is equally explicit that the spill
 * is gated by a real latency budget: a device where paging the cold KV back in
 * would miss the voice first-audio-latency target must HARD-FAIL with a
 * structured error, not silently serve a slow session.
 *
 * This module is the policy core. It is pure arithmetic — no llama-server
 * process management, no native binding. `dflash-server.ts` consults
 * `planKvSpill()` at activation time:
 *   - `mode: "resident"`  → no spill needed; load normally.
 *   - `mode: "spill"`     → pass the resulting `residentPages` /
 *                           `spillBytes` / tier ("cpu" | "disk") down to the
 *                           backend as a `--kv-spill` hint.
 *   - `mode: "unsupported"` → throw `KvSpillUnsupportedError` so the engine
 *                           surfaces a structured 4xx to the UI.
 *
 * Model parameters (page size, per-page bandwidth, voice latency budget) are
 * documented constants below — the only "measured" inputs are the device's
 * memory bandwidth class and the KV geometry of the loaded bundle. We do not
 * pretend to micro-benchmark the disk here; the bandwidth tiers are coarse
 * and conservative, and the gate fails *closed*.
 */

import type { RamBudget } from "./ram-budget";

/** Context length below which spill never applies (AGENTS.md §3 item 7). */
export const KV_SPILL_MIN_CONTEXT = 65536;

/**
 * KV-cache page granularity, in tokens. The runtime evicts/restores KV in
 * page units, not per-token, so spill accounting is page-aligned. 256 tokens
 * is the buun-llama-cpp fork's default `--kv-page-size` for the spillable
 * cache; keep this in sync if that default changes.
 */
export const KV_PAGE_TOKENS = 256;

/**
 * First-audio-latency budget for voice mode, in milliseconds. The streaming
 * contract (AGENTS.md §4) wants the phrase chunker handing the first chunk to
 * TTS inside a scheduler tick; a cold KV restore at decode time eats directly
 * into this budget. If the worst-case restore for the spilled pages exceeds
 * this, spill is not viable for a voice-enabled bundle and we hard-fail.
 *
 * Text-only bundles get the looser `KV_SPILL_TEXT_LATENCY_BUDGET_MS`.
 */
export const KV_SPILL_VOICE_LATENCY_BUDGET_MS = 200;
export const KV_SPILL_TEXT_LATENCY_BUDGET_MS = 1500;

/**
 * Effective KV transfer bandwidth back into the attention kernel, by storage
 * tier and host class, in bytes per millisecond (≈ GB/s). Conservative — the
 * gate fails closed, so under-estimating bandwidth only makes us refuse more
 * aggressively, never serve something too slow.
 *
 *   - `cpu`/`apple` : Apple Silicon unified memory — "spilling to CPU" is
 *                     mostly an accounting move (same physical RAM, different
 *                     residency bookkeeping); effective restore bandwidth is
 *                     high.
 *   - `cpu`/`pcie`  : discrete-GPU x86 — cold KV pages live in host RAM and
 *                     ride the PCIe bus back to VRAM. PCIe 4.0 x16 ≈ 25 GB/s
 *                     after framing; we budget 12.
 *   - `disk`/`nvme` : NVMe SSD — sequential read ≈ 3 GB/s; we budget 1.5.
 *   - `disk`/`sata` : SATA SSD / spinning rust fallback — ≈ 0.4 GB/s; we
 *                     budget 0.25. (Mostly here so the math is defined; in
 *                     practice this tier fails the gate immediately.)
 */
const KV_RESTORE_BANDWIDTH_BYTES_PER_MS = {
  "cpu-apple": 40_000_000,
  "cpu-pcie": 12_000_000,
  "disk-nvme": 1_500_000,
  "disk-sata": 250_000,
} as const;

export type KvRestoreClass = keyof typeof KV_RESTORE_BANDWIDTH_BYTES_PER_MS;

/**
 * Per-token KV-cache footprint of a loaded bundle, summed across all
 * full-attention layers, for the *quantized* cache it actually ships with
 * (QJL K + PolarQuant/TurboQuant V — see packages/training/AGENTS.md §3).
 * Callers derive this from the bundle's manifest / catalog runtime block;
 * `estimateQuantizedKvBytesPerToken()` is the fallback when only the param
 * count is known.
 */
export interface KvGeometry {
  /** Bytes of compressed KV the cache grows by, per generated token. */
  bytesPerToken: number;
  /** True when the loaded bundle has voice enabled (tighter latency gate). */
  voiceEnabled: boolean;
}

/**
 * Fallback per-token KV estimate when the manifest doesn't carry an explicit
 * figure. Order-of-magnitude only: QJL K-cache is ~1 bit/coord + a bf16 norm,
 * Polar V-cache is ~4 bits/coord + per-block norms, summed over the
 * full-attention layers. For Qwen3.5/3.6-class geometry that lands roughly at
 * the table below (bytes/token across the whole cache). These are the figures
 * the catalog's per-tier `ramBudgetMb` was sized against.
 */
const QUANTIZED_KV_BYTES_PER_TOKEN_BY_PARAMS: Readonly<Record<string, number>> =
  {
    "0.6B": 1_200,
    "1.7B": 2_400,
    "9B": 9_000,
    "27B": 22_000,
  };

export function estimateQuantizedKvBytesPerToken(params: string): number {
  const known = QUANTIZED_KV_BYTES_PER_TOKEN_BY_PARAMS[params];
  if (known !== undefined) return known;
  // Unknown param string — fail closed by assuming the largest tier's
  // footprint so a mis-tagged bundle errs toward refusing spill rather than
  // toward over-promising residency.
  return QUANTIZED_KV_BYTES_PER_TOKEN_BY_PARAMS["27B"];
}

/**
 * Where the spilled pages land. `"cpu"` = host RAM (still RAM, just not
 * counted against the resident budget); `"disk"` = the local-inference cache
 * directory on persistent storage.
 */
export type KvSpillTier = "cpu" | "disk";

export interface KvSpillPlanResident {
  mode: "resident";
  /** The whole KV cache fits in the resident budget; nothing spills. */
  totalKvBytes: number;
  residentBytes: number;
}

export interface KvSpillPlanSpill {
  mode: "spill";
  tier: KvSpillTier;
  /** Pages kept resident (the hot tail of the context). */
  residentPages: number;
  /** Pages paged out to `tier`. */
  spillPages: number;
  /** Bytes of KV held resident. */
  residentBytes: number;
  /** Bytes of KV spilled to `tier`. */
  spillBytes: number;
  /** Total compressed KV footprint at full context. */
  totalKvBytes: number;
  /** Worst-case latency to restore one cold page, in ms. */
  worstCaseRestoreMs: number;
  /** The latency budget this plan was checked against, in ms. */
  latencyBudgetMs: number;
}

export type KvSpillPlan = KvSpillPlanResident | KvSpillPlanSpill;

/**
 * Structured error thrown when spill cannot meet the latency budget. The
 * engine catches this and surfaces it to the UI as a 4xx with `code` and
 * `details` intact — there is NO silent-slow fallback (AGENTS.md §3).
 */
export class KvSpillUnsupportedError extends Error {
  readonly code = "kv-spill-unsupported";
  readonly details: {
    requestedContext: number;
    totalKvBytes: number;
    residentBytes: number;
    spillBytes: number;
    worstCaseRestoreMs: number;
    latencyBudgetMs: number;
    restoreClass: KvRestoreClass;
    voiceEnabled: boolean;
  };

  constructor(details: KvSpillUnsupportedError["details"]) {
    super(
      `KV-cache spill for a ${details.requestedContext}-token context cannot ` +
        `meet the ${
          details.voiceEnabled ? "voice" : "text"
        } latency budget on this device: worst-case cold-page restore is ` +
        `${details.worstCaseRestoreMs.toFixed(1)}ms vs a ${
          details.latencyBudgetMs
        }ms budget (${details.restoreClass}, ${(
          details.spillBytes / 1024 / 1024
        ).toFixed(0)} MiB would spill). Use a smaller context variant or a ` +
        `device with more RAM / faster storage.`,
    );
    this.name = "KvSpillUnsupportedError";
    this.details = details;
  }
}

/**
 * Inputs to `planKvSpill`. `residentKvBudgetBytes` is the slice of the RAM
 * budget the runtime is willing to hand to the *resident* KV cache after
 * weights + activations + the TTS/ASR working sets are accounted for; callers
 * derive it from `RamBudget` via `residentKvBudgetFromRamBudget()`.
 */
export interface KvSpillInput {
  requestedContext: number;
  geometry: KvGeometry;
  residentKvBudgetBytes: number;
  restoreClass: KvRestoreClass;
  /**
   * True when the host can spill to CPU RAM (host RAM available beyond the
   * resident budget). When false the spill tier degrades to `"disk"`.
   */
  cpuSpillAvailable: boolean;
}

/**
 * Slice the resident-KV budget out of a model's `RamBudget`. The recommended
 * budget covers weights + activations + voice working sets + KV; we reserve a
 * fixed fraction for KV. This mirrors what `recommendation.ts` already assumes
 * implicitly when it sizes tiers — kept as one constant so the spill policy
 * and the recommender agree.
 */
export const RESIDENT_KV_BUDGET_FRACTION = 0.25;

export function residentKvBudgetFromRamBudget(budget: RamBudget): number {
  return Math.floor(
    budget.recommendedMb * 1024 * 1024 * RESIDENT_KV_BUDGET_FRACTION,
  );
}

function pagesForTokens(tokens: number): number {
  return Math.ceil(tokens / KV_PAGE_TOKENS);
}

/**
 * Decide the KV-cache placement for a requested context.
 *
 * Returns `{ mode: "resident" }` when the whole compressed KV fits the
 * resident budget; `{ mode: "spill", ... }` when it fits with paging and the
 * cold-page restore stays inside the latency budget; throws
 * `KvSpillUnsupportedError` when spill would miss the budget.
 *
 * Below `KV_SPILL_MIN_CONTEXT` this is always `{ mode: "resident" }` — there
 * is no spill at short context, by contract.
 */
export function planKvSpill(input: KvSpillInput): KvSpillPlan {
  const { requestedContext, geometry, residentKvBudgetBytes } = input;

  if (
    !Number.isFinite(requestedContext) ||
    requestedContext <= 0 ||
    !Number.isFinite(geometry.bytesPerToken) ||
    geometry.bytesPerToken <= 0
  ) {
    throw new Error(
      `[kv-spill] planKvSpill needs a positive context and bytesPerToken; got context=${requestedContext}, bytesPerToken=${geometry.bytesPerToken}`,
    );
  }
  if (residentKvBudgetBytes <= 0) {
    throw new Error(
      `[kv-spill] residentKvBudgetBytes must be positive; got ${residentKvBudgetBytes}`,
    );
  }

  const pageBytes = geometry.bytesPerToken * KV_PAGE_TOKENS;
  const totalPages = pagesForTokens(requestedContext);
  const totalKvBytes = totalPages * pageBytes;

  // Whole cache fits resident — no spill, regardless of context length.
  if (totalKvBytes <= residentKvBudgetBytes) {
    return {
      mode: "resident",
      totalKvBytes,
      residentBytes: totalKvBytes,
    };
  }

  // Below the contract floor, spill is not on the table: a 64k-or-less
  // context that doesn't fit the resident budget is a wrong-tier-for-device
  // situation, not a spill case. The recommender's RAM gate should have
  // already excluded this; treat it as unsupported with the same structured
  // error so the engine surfaces it cleanly rather than half-loading.
  if (requestedContext < KV_SPILL_MIN_CONTEXT) {
    throw new KvSpillUnsupportedError({
      requestedContext,
      totalKvBytes,
      residentBytes: residentKvBudgetBytes,
      spillBytes: totalKvBytes - residentKvBudgetBytes,
      worstCaseRestoreMs: 0,
      latencyBudgetMs: 0,
      restoreClass: input.restoreClass,
      voiceEnabled: geometry.voiceEnabled,
    });
  }

  const residentPages = Math.max(
    1,
    Math.floor(residentKvBudgetBytes / pageBytes),
  );
  const spillPages = totalPages - residentPages;
  const residentBytes = residentPages * pageBytes;
  const spillBytes = spillPages * pageBytes;

  const tier: KvSpillTier = input.cpuSpillAvailable ? "cpu" : "disk";
  // When CPU spill isn't available the only restore class that makes sense is
  // a disk one; if the caller handed us a `cpu-*` class, downgrade to NVMe.
  const restoreClass: KvRestoreClass =
    tier === "disk" && input.restoreClass.startsWith("cpu-")
      ? "disk-nvme"
      : input.restoreClass;
  const bandwidth = KV_RESTORE_BANDWIDTH_BYTES_PER_MS[restoreClass];

  // Worst case at decode time: a single cold page faulted back in. (Spilling
  // by page keeps this bounded — a smaller `KV_PAGE_TOKENS` is the lever for
  // cutting the worst case if a device class needs it.)
  const worstCaseRestoreMs = pageBytes / bandwidth;
  const latencyBudgetMs = geometry.voiceEnabled
    ? KV_SPILL_VOICE_LATENCY_BUDGET_MS
    : KV_SPILL_TEXT_LATENCY_BUDGET_MS;

  if (worstCaseRestoreMs > latencyBudgetMs) {
    throw new KvSpillUnsupportedError({
      requestedContext,
      totalKvBytes,
      residentBytes,
      spillBytes,
      worstCaseRestoreMs,
      latencyBudgetMs,
      restoreClass,
      voiceEnabled: geometry.voiceEnabled,
    });
  }

  return {
    mode: "spill",
    tier,
    residentPages,
    spillPages,
    residentBytes,
    spillBytes,
    totalKvBytes,
    worstCaseRestoreMs,
    latencyBudgetMs,
  };
}

/**
 * Map a `HardwareProbe`-shaped descriptor to the KV restore bandwidth class.
 * Apple Silicon → unified-memory class; discrete-GPU x86 → PCIe class;
 * CPU-only → NVMe class (no GPU to page back to, so "restore" is a host-RAM
 * memcpy bounded by the same order as a fast SSD on the conservative side).
 */
export function restoreClassForHardware(input: {
  appleSilicon: boolean;
  hasDiscreteGpu: boolean;
}): KvRestoreClass {
  if (input.appleSilicon) return "cpu-apple";
  if (input.hasDiscreteGpu) return "cpu-pcie";
  return "disk-nvme";
}
