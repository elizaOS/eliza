/**
 * Shared memory-benchmark metric schema.
 *
 * This is the single source of truth for the per-(tier × modality) record the
 * desktop/server harness emits (issue #8809) AND the schema the mobile Resource
 * Workbench (#8800) consumes. Both surfaces read the same field names so a
 * desktop report and an on-device report line up column-for-column. Do NOT
 * rename a field here without updating both consumers — the whole point of a
 * shared schema is that the two reports are diffable.
 *
 * The field set mirrors the per-model metric list specced in
 * `plugins/plugin-local-inference/docs/memory-and-e2e-latency-review.md` §5
 * ("load ms, first-token/first-audio/first-result ms, throughput (tok/s or
 * RTF), peak RSS delta, ... eviction count") and the on-device iOS grind
 * (`plugin-capacitor-bridge/src/ios/model-grind.ts`), so the desktop harness,
 * the iOS grind, and the #8800 workbench all speak the same metric language.
 *
 * Pure ESM, built-ins only — importable from `.mjs` harness scripts and from
 * `.ts` via the same path.
 */

/** Schema version. Bump on any breaking field change so consumers can detect drift. */
export const METRIC_SCHEMA_VERSION = "1.0.0";

/**
 * The modalities a single Eliza-1 bundle can serve. One row per (tier ×
 * modality) in the report. Order is the co-residency load order used by the
 * scripted sequence (text first — it is the pinned target — then the
 * auxiliaries).
 */
export const MODALITIES = /** @type {const} */ ([
  "text",
  "embedding",
  "transcription",
  "tts",
  "vad",
  "vision",
]);

/**
 * The throughput unit per modality. Token-generating modalities report
 * tokens/sec; streaming-audio modalities report a real-time factor (RTF =
 * processing_time / audio_duration; < 1 is faster than real time). Modalities
 * with neither leave `throughput` null.
 */
export const THROUGHPUT_UNIT = /** @type {const} */ ({
  text: "tok/s",
  embedding: "tok/s",
  transcription: "rtf",
  tts: "rtf",
  vad: "rtf",
  vision: "tok/s",
});

/**
 * The canonical metric record. Every harness (desktop #8809, mobile #8800,
 * iOS grind) emits rows of this exact shape.
 *
 * @typedef {Object} ModalityMetric
 * @property {string}  tier         Eliza-1 tier id (e.g. "eliza-1-2b").
 * @property {string}  modality     One of MODALITIES.
 * @property {boolean} measured     true when a real load+run produced the numbers; false when skipped.
 * @property {string=} skipReason   Present iff measured === false — why this row was not measured.
 * @property {number|null} loadMs        Wall-clock ms to bring the model online (load only).
 * @property {number|null} firstResultMs Ms from request to first token/audio/result (TTAP component).
 * @property {number|null} throughput    tok/s or RTF per THROUGHPUT_UNIT[modality]; null when N/A.
 * @property {string|null} throughputUnit "tok/s" | "rtf" | null.
 * @property {number|null} rssBeforeMb   Resident RSS (MB) sampled immediately before the load.
 * @property {number|null} rssAfterMb    Resident RSS (MB) sampled immediately after the load+run.
 * @property {number|null} rssDeltaMb    rssAfterMb - rssBeforeMb (the resident footprint this model added).
 * @property {number|null} peakRssMb     Peak RSS (MB) observed across the load+run window.
 * @property {number|null} estimatedMb   The model's declared estimatedMb (what the arbiter budgets against), when known.
 */

/**
 * The co-residency record. One per harness run. Captures the eviction telemetry
 * emitted by the MemoryArbiter while the scripted sequence
 * (load text → load vision → load voice → force pressure) executes.
 *
 * @typedef {Object} CoResidencyMetric
 * @property {boolean} measured        true when real backends drove the sequence; false when it ran as the wiring self-check.
 * @property {string}  mode            "real" | "self-check".
 * @property {string[]} sequence       Ordered list of capability::modelKey loads attempted.
 * @property {number}  loadCount       arbiter "model_load" events observed.
 * @property {number}  evictionCount   arbiter "eviction" events observed (fit + pressure + swap).
 * @property {number}  pressureEvents  arbiter "memory_pressure" events observed.
 * @property {number}  budgetMb        the usable-RAM budget the arbiter fit-path was driven against.
 * @property {Array<{capability:string,modelKey:string,reason:string,estimatedMb:number}>} evictions
 */

/** The top-level report envelope. */
export const METRIC_SCHEMA = Object.freeze({
  version: METRIC_SCHEMA_VERSION,
  /** Field names a consumer (#8800) can rely on per modality row. */
  modalityFields: Object.freeze([
    "tier",
    "modality",
    "measured",
    "skipReason",
    "loadMs",
    "firstResultMs",
    "throughput",
    "throughputUnit",
    "rssBeforeMb",
    "rssAfterMb",
    "rssDeltaMb",
    "peakRssMb",
    "estimatedMb",
  ]),
  /** Field names a consumer can rely on for the co-residency block. */
  coResidencyFields: Object.freeze([
    "measured",
    "mode",
    "sequence",
    "loadCount",
    "evictionCount",
    "pressureEvents",
    "budgetMb",
    "evictions",
  ]),
  modalities: MODALITIES,
  throughputUnit: THROUGHPUT_UNIT,
  /** Consumers: this issue (#8809 desktop/server) and #8800 (mobile workbench). */
  sharedWith: Object.freeze(["#8809", "#8800"]),
});

/** Build an empty (skipped) modality row with the canonical fields populated. */
export function skippedModalityRow(tier, modality, skipReason) {
  return {
    tier,
    modality,
    measured: false,
    skipReason,
    loadMs: null,
    firstResultMs: null,
    throughput: null,
    throughputUnit: THROUGHPUT_UNIT[modality] ?? null,
    rssBeforeMb: null,
    rssAfterMb: null,
    rssDeltaMb: null,
    peakRssMb: null,
    estimatedMb: null,
  };
}
