/**
 * The executor seam the runner uses to actually run one analyzer against one
 * subject. Extracting it from {@link analyzeArtifacts} lets the same fan-out
 * loop drive an analyzer inline (the default) OR hand it off to another process
 * — the GPU job queue routes `gpu`-tier analyzers to a resident vision worker
 * through a `QueueExecutor` (`../queue/executor.ts`, #14543) so a certification
 * run does not load a model per image. Every executor upholds the same honest
 * contract the runner documents: tier gating, wall-clock timing, and a `failed`
 * record when the analyze call throws — never a fabricated empty result.
 */

import { tierRunnable } from "./registry.ts";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerInput,
  AnalyzerResult,
} from "./types.ts";

/**
 * Runs one analyzer and returns its honest result record. Implementations must
 * apply tier gating (`skipped-tier` when the analyzer is above the run tier),
 * time the call, and translate a throw into a `failed` record rather than
 * letting it escape — the runner treats this as the single place an analyzer's
 * outcome is produced.
 */
export interface AnalyzerExecutor {
  execute(
    analyzer: Analyzer,
    input: AnalyzerInput,
    ctx: AnalyzerContext,
  ): Promise<AnalyzerResult>;
}

/**
 * Run `analyzer` in-process: gate on tier, time the call, coerce any throw into
 * a `failed` record. This is the canonical semantics every other executor must
 * preserve; the {@link InlineExecutor} and the queue worker both call it so the
 * result shape is identical whether an analyzer ran locally or on a GPU box.
 */
export async function runAnalyzerInline(
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
    // error-policy:J1 boundary translation — the executor is the boundary that
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

/** The default executor: runs every analyzer in-process via {@link runAnalyzerInline}. */
export class InlineExecutor implements AnalyzerExecutor {
  execute(
    analyzer: Analyzer,
    input: AnalyzerInput,
    ctx: AnalyzerContext,
  ): Promise<AnalyzerResult> {
    return runAnalyzerInline(analyzer, input, ctx);
  }
}

/** Shared inline executor; stateless, so a single instance serves every runner. */
export const INLINE_EXECUTOR: AnalyzerExecutor = new InlineExecutor();
