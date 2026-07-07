/**
 * Self-contained optimization run reports for auto-training audits.
 *
 * The training orchestrator owns run records, optimized-prompt artifacts, and
 * promotion-gate outcomes. This module folds those pieces into a stable JSON
 * payload plus a standalone HTML view so operators can inspect what changed
 * without reading raw `vN.json` files.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { logger } from "@elizaos/core";
import type { PromotionDecisionSummary } from "../optimizers/types.js";
import { trainingStateRoot } from "./training-config.js";
import type { TrainingRunRecord } from "./training-orchestrator.js";

export const OPTIMIZATION_RUN_REPORT_SCHEMA = "eliza_optimization_run_report";
export const OPTIMIZATION_RUN_REPORT_VERSION = 1;

export interface OptimizationPromptDiff {
  baselineChars: number;
  optimizedChars: number;
  baselineLineCount: number;
  optimizedLineCount: number;
  removedLines: readonly string[];
  addedLines: readonly string[];
  changed: boolean;
}

export interface OptimizationRunReport {
  schema: typeof OPTIMIZATION_RUN_REPORT_SCHEMA;
  version: typeof OPTIMIZATION_RUN_REPORT_VERSION;
  generatedAt: string;
  run: {
    runId: string;
    status: TrainingRunRecord["status"];
    task: TrainingRunRecord["task"];
    backend: TrainingRunRecord["backend"];
    source: TrainingRunRecord["source"];
    datasetSize: number;
    startedAt: string;
    finishedAt: string;
    artifactPath?: string;
    rejectedCandidatePath?: string;
  };
  headline: {
    verdict: "promoted" | "rejected" | "skipped" | "failed" | "unknown";
    scoreDelta: number | null;
    tokenDelta: number | null;
    summary: string;
  };
  promptDiff: OptimizationPromptDiff | null;
  lineage: readonly {
    round: number;
    variant: number;
    score: number;
    notes?: string;
  }[];
  frontier: readonly {
    prompt: string;
    score: number;
    promptTokenCount: number;
    origin: string;
    feedback?: string;
    promoted?: boolean;
  }[];
  promotionGate: Record<string, unknown> | null;
  providerAblations: {
    status: "unavailable";
    reason: string;
  };
  renderingVariants: {
    status: "unavailable";
    reason: string;
  };
  notes: readonly string[];
}

export interface OptimizationRunReportWriteResult {
  reportJsonPath: string;
  reportHtmlPath: string;
  report: OptimizationRunReport;
}

interface ArtifactLike {
  baseline?: unknown;
  prompt?: unknown;
  candidatePrompt?: unknown;
  incumbentPrompt?: unknown;
  score?: unknown;
  baselineScore?: unknown;
  lineage?: unknown;
  frontier?: unknown;
  promotionDecision?: PromotionDecisionSummary;
  scores?: unknown;
  reason?: unknown;
}

function runReportDir(runId: string): string {
  return join(trainingStateRoot(), "runs", runId);
}

function reportPaths(runId: string): {
  reportJsonPath: string;
  reportHtmlPath: string;
} {
  const dir = runReportDir(runId);
  return {
    reportJsonPath: join(dir, "report.json"),
    reportHtmlPath: join(dir, "report.html"),
  };
}

function rejectedCandidatePathFromNotes(
  notes: readonly string[],
): string | null {
  for (const note of notes) {
    const match = note.match(/rejected candidate written to (.+)$/u);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

async function readArtifact(
  path: string | null | undefined,
): Promise<ArtifactLike | null> {
  if (!path || !existsSync(path)) return null;
  const raw = await readFile(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // error-policy:J3 corrupt on-disk artifact is untrusted input; degrade the
    // report to "unavailable" rather than failing the run-record write.
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(
      `[optimization-report] skipping unparseable artifact at ${path}: ${detail}`,
    );
    return null;
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as ArtifactLike)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeLines(value: string): string[] {
  return value.replace(/\r\n/gu, "\n").split("\n");
}

export function buildPromptDiff(
  baseline: string,
  optimized: string,
): OptimizationPromptDiff {
  const baselineLines = normalizeLines(baseline);
  const optimizedLines = normalizeLines(optimized);
  let prefix = 0;
  while (
    prefix < baselineLines.length &&
    prefix < optimizedLines.length &&
    baselineLines[prefix] === optimizedLines[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix + prefix < baselineLines.length &&
    suffix + prefix < optimizedLines.length &&
    baselineLines[baselineLines.length - 1 - suffix] ===
      optimizedLines[optimizedLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const baselineEnd = baselineLines.length - suffix;
  const optimizedEnd = optimizedLines.length - suffix;
  return {
    baselineChars: baseline.length,
    optimizedChars: optimized.length,
    baselineLineCount: baselineLines.length,
    optimizedLineCount: optimizedLines.length,
    removedLines: baselineLines.slice(prefix, baselineEnd),
    addedLines: optimizedLines.slice(prefix, optimizedEnd),
    changed: baseline !== optimized,
  };
}

function coerceLineage(value: unknown): OptimizationRunReport["lineage"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): OptimizationRunReport["lineage"][number][] => {
    const record = objectValue(entry);
    if (!record) return [];
    const round = numberValue(record.round);
    const variant = numberValue(record.variant);
    const score = numberValue(record.score);
    if (round === null || variant === null || score === null) return [];
    return [
      {
        round,
        variant,
        score,
        notes: stringValue(record.notes) ?? undefined,
      },
    ];
  });
}

function coerceFrontier(
  value: unknown,
  optimizedPrompt: string | null,
): OptimizationRunReport["frontier"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): OptimizationRunReport["frontier"][number][] => {
    const record = objectValue(entry);
    if (!record) return [];
    const prompt = stringValue(record.prompt);
    const score = numberValue(record.score);
    const promptTokenCount = numberValue(record.promptTokenCount);
    const origin = stringValue(record.origin);
    if (!prompt || score === null || promptTokenCount === null || !origin) {
      return [];
    }
    return [
      {
        prompt,
        score,
        promptTokenCount,
        origin,
        feedback: stringValue(record.feedback) ?? undefined,
        promoted: optimizedPrompt ? prompt === optimizedPrompt : undefined,
      },
    ];
  });
}

function round(value: number | null): number | null {
  return value === null ? null : Number(value.toFixed(4));
}

export function buildOptimizationRunReport(input: {
  run: TrainingRunRecord;
  artifact?: ArtifactLike | null;
  rejectedArtifact?: ArtifactLike | null;
  generatedAt?: string;
}): OptimizationRunReport {
  const artifact = input.artifact ?? null;
  const rejected = input.rejectedArtifact ?? null;
  const baseline =
    stringValue(artifact?.baseline) ?? stringValue(rejected?.incumbentPrompt);
  const optimized =
    stringValue(artifact?.prompt) ?? stringValue(rejected?.candidatePrompt);
  const score = numberValue(artifact?.score);
  const baselineScore = numberValue(artifact?.baselineScore);
  const rejectedScores = objectValue(rejected?.scores);
  const rejectedDelta = numberValue(rejectedScores?.delta);
  const scoreDelta =
    score !== null && baselineScore !== null
      ? score - baselineScore
      : rejectedDelta;
  const promptDiff =
    baseline && optimized ? buildPromptDiff(baseline, optimized) : null;
  const tokenDelta = promptDiff
    ? promptDiff.optimizedChars - promptDiff.baselineChars
    : null;
  const promotionGate =
    objectValue(artifact?.promotionDecision) ??
    (rejectedScores
      ? {
          promote: false,
          ...rejectedScores,
          reason: stringValue(rejected?.reason) ?? "candidate rejected",
        }
      : null);
  const rejectedPath = rejectedCandidatePathFromNotes(input.run.notes ?? []);
  const verdict =
    input.run.status === "failed"
      ? "failed"
      : input.run.status === "skipped"
        ? "skipped"
        : artifact
          ? "promoted"
          : rejected
            ? "rejected"
            : "unknown";
  return {
    schema: OPTIMIZATION_RUN_REPORT_SCHEMA,
    version: OPTIMIZATION_RUN_REPORT_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    run: {
      runId: input.run.runId,
      status: input.run.status,
      task: input.run.task,
      backend: input.run.backend,
      source: input.run.source,
      datasetSize: input.run.datasetSize,
      startedAt: input.run.startedAt,
      finishedAt: input.run.finishedAt,
      artifactPath: input.run.artifactPath,
      rejectedCandidatePath: rejectedPath ?? undefined,
    },
    headline: {
      verdict,
      scoreDelta: round(scoreDelta),
      tokenDelta,
      summary:
        verdict === "promoted"
          ? "Candidate cleared the promotion gate and became the current prompt."
          : verdict === "rejected"
            ? "Candidate was preserved as a rejected artifact with gate diagnostics."
            : (input.run.reason ?? "Run completed without a prompt artifact."),
    },
    promptDiff,
    lineage: coerceLineage(artifact?.lineage),
    frontier: coerceFrontier(artifact?.frontier, optimized),
    promotionGate,
    providerAblations: {
      status: "unavailable",
      reason:
        "Provider-attribution capture is tracked by the companion issue and is not present in this run record.",
    },
    renderingVariants: {
      status: "unavailable",
      reason:
        "Rendering-variant comparisons require seeded multi-render optimizer runs; this report reserves the section without fabricating data.",
    },
    notes: input.run.notes ?? [],
  };
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderLines(lines: readonly string[], marker: "+" | "-"): string {
  if (lines.length === 0) return "<p>None</p>";
  return `<pre>${lines
    .map((line) => `${marker} ${escapeHtml(line)}`)
    .join("\n")}</pre>`;
}

export function renderOptimizationRunReportHtml(
  report: OptimizationRunReport,
): string {
  const frontierRows = report.frontier
    .map(
      (entry) =>
        `<tr><td>${escapeHtml(entry.origin)}</td><td>${entry.score.toFixed(4)}</td><td>${entry.promptTokenCount}</td><td>${entry.promoted ? "yes" : ""}</td></tr>`,
    )
    .join("");
  const lineageRows = report.lineage
    .map(
      (entry) =>
        `<tr><td>${entry.round}</td><td>${entry.variant}</td><td>${entry.score.toFixed(4)}</td><td>${escapeHtml(entry.notes ?? "")}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Optimization Run ${escapeHtml(report.run.runId)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; padding: 24px; background: Canvas; color: CanvasText; }
    main { max-width: 1120px; margin: 0 auto; }
    section { border-top: 1px solid color-mix(in srgb, CanvasText 18%, transparent); padding: 18px 0; }
    h1, h2 { margin: 0 0 10px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .metric { border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); border-radius: 6px; padding: 10px; }
    table { border-collapse: collapse; width: 100%; }
    th, td { border-bottom: 1px solid color-mix(in srgb, CanvasText 14%, transparent); padding: 8px; text-align: left; vertical-align: top; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; border-radius: 6px; background: color-mix(in srgb, CanvasText 8%, transparent); }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
<main>
  <h1>Optimization Run ${escapeHtml(report.run.runId)}</h1>
  <p>${escapeHtml(report.headline.summary)}</p>
  <section class="grid">
    <div class="metric"><strong>Verdict</strong><br>${escapeHtml(report.headline.verdict)}</div>
    <div class="metric"><strong>Task</strong><br>${escapeHtml(report.run.task ?? "n/a")}</div>
    <div class="metric"><strong>Dataset rows</strong><br>${report.run.datasetSize}</div>
    <div class="metric"><strong>Score delta</strong><br>${escapeHtml(report.headline.scoreDelta ?? "n/a")}</div>
    <div class="metric"><strong>Token/char delta</strong><br>${escapeHtml(report.headline.tokenDelta ?? "n/a")}</div>
  </section>
  <section>
    <h2>Prompt Diff</h2>
    <h3>Removed</h3>
    ${report.promptDiff ? renderLines(report.promptDiff.removedLines, "-") : "<p>No prompt artifact available.</p>"}
    <h3>Added</h3>
    ${report.promptDiff ? renderLines(report.promptDiff.addedLines, "+") : "<p>No prompt artifact available.</p>"}
  </section>
  <section>
    <h2>Lineage</h2>
    <table><thead><tr><th>Round</th><th>Variant</th><th>Score</th><th>Notes</th></tr></thead><tbody>${lineageRows}</tbody></table>
  </section>
  <section>
    <h2>Quality vs Tokens Frontier</h2>
    <table><thead><tr><th>Origin</th><th>Score</th><th>Prompt tokens</th><th>Promoted</th></tr></thead><tbody>${frontierRows}</tbody></table>
  </section>
  <section>
    <h2>Promotion Gate</h2>
    <pre>${escapeHtml(JSON.stringify(report.promotionGate, null, 2))}</pre>
  </section>
  <section>
    <h2>Provider Ablations</h2>
    <p>${escapeHtml(report.providerAblations.reason)}</p>
    <h2>Rendering Variants</h2>
    <p>${escapeHtml(report.renderingVariants.reason)}</p>
  </section>
</main>
</body>
</html>
`;
}

export async function writeOptimizationRunReport(
  run: TrainingRunRecord,
): Promise<OptimizationRunReportWriteResult> {
  const rejectedPath = rejectedCandidatePathFromNotes(run.notes ?? []);
  const [artifact, rejectedArtifact] = await Promise.all([
    readArtifact(run.artifactPath),
    readArtifact(rejectedPath),
  ]);
  const report = buildOptimizationRunReport({
    run,
    artifact,
    rejectedArtifact,
  });
  const paths = reportPaths(run.runId);
  await mkdir(dirname(paths.reportJsonPath), { recursive: true });
  await writeFile(
    paths.reportJsonPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf-8",
  );
  await writeFile(
    paths.reportHtmlPath,
    renderOptimizationRunReportHtml(report),
    "utf-8",
  );
  return { ...paths, report };
}
