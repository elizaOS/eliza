/**
 * Contract for the tiered heuristic analyzer registry (#14542). An analyzer is
 * a pure `(input, ctx) → result-fragment` unit that declares which artifact
 * kinds it consumes and which tier it belongs to; the runner fans every
 * applicable analyzer over every artifact and merges the fragments into ONE
 * `analysis.json` per visual subject. Every run records an honest per-analyzer
 * status — `ran | skipped-tier | skipped-missing-tool | failed` — so a missing
 * `tesseract`/`ffmpeg` or an out-of-tier GPU analyzer produces an explicit
 * record with a reason, never a silent skip and never fabricated empty data
 * (repo error-handling doctrine: "not loaded" must never read as "zero").
 *
 * The registry is data, not a plugin system: a flat array plus a lookup, no
 * dynamic loading. Analyzers that shell out (tesseract, ffmpeg) or call a
 * remote service (the GPU vision lane) surface unavailability through their
 * status, not through throwing — a throw is reserved for a genuine analysis
 * bug and is caught by the runner into a `failed` record with the message.
 */

import type { ArtifactEntry, ArtifactKind, Tier } from "../schema.ts";

/** Honest outcome of running one analyzer against one artifact. */
export type AnalyzerStatus =
  | "ran"
  | "skipped-tier"
  | "skipped-missing-tool"
  | "failed";

/**
 * The subject an analyzer operates on: an artifact entry plus its absolute path
 * on disk. Analyzers read `absolutePath`; `entry` carries the bundle-relative
 * path, kind, and provenance used for placement and reporting.
 */
export interface AnalyzerInput {
  entry: ArtifactEntry;
  /** Absolute filesystem path to the artifact bytes. */
  absolutePath: string;
}

/**
 * Resolves a baseline (previous-run) artifact for a given subject so diff
 * analyzers can compare against it. Caller-provided — the registry hardcodes no
 * baseline directory. Returns an absolute path to the baseline image, or null
 * when none exists (a first run, or a newly added subject).
 */
export type BaselineResolver = (
  input: AnalyzerInput,
) => string | null | Promise<string | null>;

/**
 * Per-artifact expectations threaded to analyzers that support them (currently
 * `diff.region`). Regions are in normalized [0,1] coordinates relative to the
 * compared grid so they are resolution-independent.
 */
export interface RegionExpectation {
  /** Normalized bounding box `{ x, y, w, h }` in [0,1]. */
  region: { x: number; y: number; w: number; h: number };
  /** `change` asserts the region MUST change; `static` asserts it must NOT. */
  kind: "change" | "static";
  /** Optional label surfaced in the assertion result. */
  label?: string;
}

/** Analysis inputs the caller may attach per subject, keyed by bundle path. */
export interface AnalyzerExpectations {
  regions?: RegionExpectation[];
}

/**
 * Emit a derived artifact (e.g. a video keyframe) back into the bundle, returning
 * the new artifact's input so the runner can fan image analyzers over it.
 */
export type EmitArtifact = (
  filePath: string,
  options: {
    kind: ArtifactKind;
    bundlePath: string;
    producedBy: string;
  },
) => Promise<AnalyzerInput>;

/** Shared context passed to every analyzer for one run. */
export interface AnalyzerContext {
  /** Tier the run is executing at; analyzers above it record `skipped-tier`. */
  tier: Tier;
  /** Resolve a baseline image for diff analyzers, or null when unavailable. */
  baselineResolver?: BaselineResolver;
  /** Per-subject expectations, keyed by the subject's bundle-relative path. */
  expectations?: Record<string, AnalyzerExpectations>;
  /**
   * Emit a derived artifact back into the bundle. Absent when the runner has no
   * bundle handle — analyzers that need it record `skipped-missing-tool`.
   */
  emitArtifact?: EmitArtifact;
}

/**
 * One analyzer's contribution to a subject's `analysis.json`. `data` is present
 * only when `status === 'ran'`; a skip or failure carries a `reason` and no
 * fabricated data. `durationMs` is wall-clock for the analyze call.
 */
export interface AnalyzerResult {
  status: AnalyzerStatus;
  reason?: string;
  durationMs: number;
  /** Analyzer-specific payload; only set when `status === 'ran'`. */
  data?: unknown;
}

/**
 * A registered analyzer. `analyze` returns a status-bearing fragment; it should
 * report unavailability via `{ status: 'skipped-missing-tool', reason }` rather
 * than throw. Throwing is caught by the runner into a `failed` record.
 */
export interface Analyzer {
  /** Stable dotted id, e.g. `ocr.tesseract`, `diff.region`. */
  name: string;
  tier: Tier;
  /** Artifact kinds this analyzer consumes. */
  kinds: readonly ArtifactKind[];
  analyze(
    input: AnalyzerInput,
    ctx: AnalyzerContext,
  ): Promise<AnalyzerFragment> | AnalyzerFragment;
}

/**
 * What an analyzer's `analyze` returns before the runner stamps `durationMs`.
 * `ran` must carry `data`; every other status must carry a `reason` and no
 * `data`. Encoded as a discriminated union so the "no fabricated data on skip"
 * rule is enforced by the type system, not by convention.
 */
export type AnalyzerFragment =
  | { status: "ran"; data: unknown }
  | {
      status: "skipped-tier" | "skipped-missing-tool" | "failed";
      reason: string;
    };

/** Schema-1 `analysis.json`: one per visual subject, keyed by analyzer name. */
export interface AnalysisDocument {
  schema: 1;
  /** Bundle-relative path of the artifact these results describe. */
  artifact: string;
  results: Record<string, AnalyzerResult>;
}
