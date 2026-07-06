/**
 * The analyzer runner: fans every applicable analyzer over every visual subject
 * in a bundle and writes ONE `analysis.json` per subject beside its pixels. The
 * contract is honest reporting — a subject's document records every analyzer
 * that could apply to its kind, each with a real status:
 *
 *   ran                    the analyzer executed and produced data
 *   skipped-tier           the analyzer's tier is above the run tier
 *   skipped-missing-tool   a required binary/endpoint/baseline was unavailable
 *   failed                 the analyze call threw (message captured in reason)
 *
 * No analyzer is silently dropped and no skip fabricates empty data (repo
 * doctrine: "not loaded" must never read as "zero"). Video analyzers emit
 * keyframe artifacts through the bundle; the runner then fans the image
 * analyzers over those emitted keyframes in the same pass, so a video is covered
 * by the image heuristics without any of them knowing about video.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { EvidenceBundle } from "../bundle.ts";
import type { ArtifactEntry, Tier } from "../schema.ts";
import { ANALYZERS, analyzersForKind, tierRunnable } from "./registry.ts";
import type {
  AnalysisDocument,
  Analyzer,
  AnalyzerContext,
  AnalyzerExpectations,
  AnalyzerInput,
  AnalyzerResult,
  BaselineResolver,
  EmitArtifact,
} from "./types.ts";

/** Options for {@link analyzeArtifacts}. */
export interface AnalyzeOptions {
  /** Tier the run executes at; analyzers above it record `skipped-tier`. */
  tier: Tier;
  /** Restrict to this analyzer set (defaults to the full registry). */
  analyzers?: readonly Analyzer[];
  baselineResolver?: BaselineResolver;
  /** Per-subject expectations, keyed by bundle-relative artifact path. */
  expectations?: Record<string, AnalyzerExpectations>;
  /**
   * Bundle to emit derived artifacts (keyframes) and write `analysis.json`
   * into. When omitted, analyzers requiring emission skip honestly and no
   * documents are written (the caller consumes the returned documents directly).
   */
  bundle?: EvidenceBundle;
}

/** One subject's analysis outcome. */
export interface SubjectAnalysis {
  artifact: string;
  document: AnalysisDocument;
  /** Where `analysis.json` was written, when a bundle was provided. */
  documentPath?: string;
}

/** Result of {@link analyzeArtifacts}. */
export interface AnalyzeResult {
  subjects: SubjectAnalysis[];
}

/**
 * Run the analyzer matrix over a bundle's artifacts. `entries` are the artifact
 * records to analyze (typically a manifest's `artifacts`); `bundleDir` is the
 * absolute directory those paths are relative to. Returns per-subject analysis
 * documents; when a bundle is supplied, each is also written as `analysis.json`
 * beside the subject.
 */
export async function analyzeArtifacts(
  bundleDir: string,
  entries: readonly ArtifactEntry[],
  options: AnalyzeOptions,
): Promise<AnalyzeResult> {
  const analyzers = options.analyzers ?? ANALYZERS;

  const subjects: SubjectAnalysis[] = [];

  // A work queue so keyframes emitted while analyzing a video are themselves
  // analyzed in the same pass. Video analyzers run first per subject, so any
  // keyframe they emit is appended before the queue advances past the video.
  const queue: AnalyzerInput[] = entries.map((entry) => ({
    entry,
    absolutePath: path.join(bundleDir, ...entry.path.split("/")),
  }));
  const emittedKeyframes: AnalyzerInput[] = [];

  // The bundle-backed emit both adds the artifact and tees it into the queue's
  // drain buffer so the runner picks it up. Absent when there is no bundle.
  const ctx: AnalyzerContext = {
    tier: options.tier,
    baselineResolver: options.baselineResolver,
    expectations: options.expectations,
    emitArtifact: options.bundle
      ? wrapEmit(makeEmitArtifact(options.bundle, bundleDir), emittedKeyframes)
      : undefined,
  };

  const seen = new Set<string>();
  while (queue.length > 0) {
    const input = queue.shift() as AnalyzerInput;
    if (seen.has(input.entry.path)) continue;
    seen.add(input.entry.path);

    const applicable = analyzersForKind(input.entry.kind, analyzers);
    if (applicable.length === 0) continue;

    const results: Record<string, AnalyzerResult> = {};
    for (const analyzer of applicable) {
      results[analyzer.name] = await runOne(analyzer, input, ctx);
    }
    // Drain keyframes emitted during this subject's analysis into the queue.
    while (emittedKeyframes.length > 0) {
      queue.push(emittedKeyframes.shift() as AnalyzerInput);
    }

    const document: AnalysisDocument = {
      schema: 1,
      artifact: input.entry.path,
      results,
    };
    const subject: SubjectAnalysis = {
      artifact: input.entry.path,
      document,
    };
    if (options.bundle) {
      subject.documentPath = await writeAnalysisDocument(
        options.bundle,
        input.entry,
        document,
      );
    }
    subjects.push(subject);
  }

  return { subjects };
}

/** Run one analyzer, timing it and coercing any throw into a `failed` record. */
async function runOne(
  analyzer: Analyzer,
  input: AnalyzerInput,
  ctx: AnalyzerContext,
): Promise<AnalyzerResult> {
  if (!tierRunnable(analyzer.tier, ctx.tier)) {
    return {
      status: "skipped-tier",
      reason: `analyzer tier '${analyzer.tier}' above run tier '${ctx.tier}'`,
      durationMs: 0,
    };
  }
  const start = performance.now();
  try {
    const fragment = await analyzer.analyze(input, ctx);
    const durationMs = Math.round(performance.now() - start);
    if (fragment.status === "ran") {
      return { status: "ran", durationMs, data: fragment.data };
    }
    return { status: fragment.status, reason: fragment.reason, durationMs };
  } catch (error) {
    // error-policy:J1 boundary translation — the runner is the boundary that
    // turns one analyzer's failure into a per-analyzer `failed` record so a
    // single broken analyzer cannot fail the whole matrix or hide its error.
    return {
      status: "failed",
      reason: String(error instanceof Error ? error.message : error).slice(
        0,
        300,
      ),
      durationMs: Math.round(performance.now() - start),
    };
  }
}

/**
 * Bind the bundle's `addArtifact` into the analyzer `emitArtifact` shape,
 * translating a bundle entry back into an `AnalyzerInput` so the runner can fan
 * image analyzers over the emitted keyframe.
 */
function makeEmitArtifact(
  bundle: EvidenceBundle,
  bundleDir: string,
): EmitArtifact {
  return async (filePath, emitOptions) => {
    const entry = await bundle.addArtifact(filePath, {
      kind: emitOptions.kind,
      source: emitOptions.producedBy,
      producedBy: emitOptions.producedBy,
      bundlePath: emitOptions.bundlePath,
    });
    return {
      entry,
      absolutePath: path.join(bundleDir, ...entry.path.split("/")),
    };
  };
}

/** Tee emitted artifacts into a queue the runner drains, preserving the emit. */
function wrapEmit(emit: EmitArtifact, sink: AnalyzerInput[]): EmitArtifact {
  return async (filePath, options) => {
    const input = await emit(filePath, options);
    sink.push(input);
    return input;
  };
}

/**
 * Write a subject's `analysis.json` beside its pixels via the bundle so it is
 * inventoried in the manifest. The document lives at
 * `<subject-dir>/<basename>.analysis.json` so multiple subjects in one dir do
 * not collide. The document is written to a scratch file first because the
 * bundle copies/hardlinks artifacts from a source path; the scratch file is
 * cleaned up after the copy. Returns the bundle-relative path it was added at.
 */
async function writeAnalysisDocument(
  bundle: EvidenceBundle,
  entry: ArtifactEntry,
  document: AnalysisDocument,
): Promise<string> {
  const dir = path.posix.dirname(entry.path);
  const base = path.posix.basename(entry.path);
  const bundlePath =
    dir === "." ? `${base}.analysis.json` : `${dir}/${base}.analysis.json`;
  const scratchDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "evidence-analysis-"),
  );
  const scratch = path.join(scratchDir, `${base}.analysis.json`);
  fs.writeFileSync(scratch, `${JSON.stringify(document, null, 2)}\n`);
  try {
    const added = await bundle.addArtifact(scratch, {
      kind: "analysis",
      source: "analyzer",
      producedBy: "analyzeArtifacts",
      bundlePath,
    });
    return added.path;
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }
}
