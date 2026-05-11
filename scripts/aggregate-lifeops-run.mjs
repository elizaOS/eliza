#!/usr/bin/env bun
/**
 * Aggregate one lifeops run into per-scenario JSONL + a single `report.md`
 * + `report.json` + `steps.csv` for analysis.
 *
 * Inputs (in order of precedence):
 *   --run-dir <dir>          (default: $MILADY_LIFEOPS_RUN_DIR)
 *   --trajectory-dir <dir>   (default: <runDir>/trajectories or $MILADY_TRAJECTORY_DIR)
 *   --run-id <id>            (default: $MILADY_LIFEOPS_RUN_ID — used to filter)
 *   --harness <name>         (default: $MILADY_BENCH_HARNESS or "eliza")
 *   --model-tier <tier>      (default: $MILADY_BENCH_MODEL_TIER or "large")
 *   --pre-release            (default: false unless $MILADY_BENCH_PRE_RELEASE=1)
 *
 * Output layout (created if missing):
 *   <runDir>/scenarios/<idx>-<scenarioId>/
 *     run.jsonl
 *     meta.json
 *   <runDir>/report.md
 *   <runDir>/report.json     (lifeops-bench-v1)
 *   <runDir>/steps.csv
 *
 * The script walks every trajectory JSON under <trajectory-dir>, emits one
 * JSONL line per `RecordedStage`, and rolls up per-scenario + run-level
 * aggregates (cache hit %, total tokens, durations, tool-call success rate,
 * tool-search count). The `report.json` artifact is validated against the
 * canonical Zod schema from `@elizaos-benchmarks/lib` before write — a
 * validation failure aborts the script.
 *
 * Cache-hit math (matches cache-observation.ts after the 2026-05-09 fix):
 *   total_input = input_tokens + cache_creation + cache_read
 *   cache_hit_pct = cache_read / total_input
 *
 * NOTE: this script runs under `bun` so the `.ts` schema in
 * `@elizaos-benchmarks/lib` is importable directly without a build step.
 */

import fs from "node:fs";
import path from "node:path";
import {
  REPORT_SCHEMA_VERSION,
  ReportSchema,
} from "@elizaos-benchmarks/lib";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : fallback;
}

const runDir = path.resolve(arg("--run-dir", process.env.MILADY_LIFEOPS_RUN_DIR ?? ""));
if (!runDir) {
  console.error(
    "[aggregate-lifeops-run] --run-dir required (or set MILADY_LIFEOPS_RUN_DIR).",
  );
  process.exit(2);
}
const trajectoryDir = path.resolve(
  arg(
    "--trajectory-dir",
    process.env.MILADY_TRAJECTORY_DIR ?? path.join(runDir, "trajectories"),
  ),
);
const runIdFilter = arg("--run-id", process.env.MILADY_LIFEOPS_RUN_ID);

const HARNESS_VALID = new Set(["hermes", "openclaw", "eliza"]);
const MODEL_TIER_VALID = new Set(["small", "mid", "large", "frontier"]);

const harness = arg(
  "--harness",
  process.env.MILADY_BENCH_HARNESS ?? "eliza",
);
if (!HARNESS_VALID.has(harness)) {
  console.error(
    `[aggregate-lifeops-run] --harness must be one of hermes|openclaw|eliza (got ${harness})`,
  );
  process.exit(2);
}

const modelTierCli = arg(
  "--model-tier",
  process.env.MILADY_BENCH_MODEL_TIER ?? "large",
);
if (!MODEL_TIER_VALID.has(modelTierCli)) {
  console.error(
    `[aggregate-lifeops-run] --model-tier must be one of small|mid|large|frontier (got ${modelTierCli})`,
  );
  process.exit(2);
}

const preReleaseFlag =
  process.argv.includes("--pre-release") ||
  ["1", "true", "yes"].includes(
    (process.env.MILADY_BENCH_PRE_RELEASE ?? "").trim().toLowerCase(),
  );

if (!fs.existsSync(trajectoryDir)) {
  console.error(`[aggregate-lifeops-run] trajectory dir does not exist: ${trajectoryDir}`);
  process.exit(2);
}

function* walkJson(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkJson(p);
    else if (entry.isFile() && entry.name.endsWith(".json")) yield p;
  }
}

function safeNum(n) {
  return Number.isFinite(n) ? n : 0;
}
function pct(num, denom) {
  return denom > 0 ? +((num / denom) * 100).toFixed(2) : 0;
}

function fmtSlug(s) {
  return String(s ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80);
}

const trajectories = [];
for (const file of walkJson(trajectoryDir)) {
  let j;
  try {
    j = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`[aggregate-lifeops-run] skip ${file}: ${err.message}`);
    continue;
  }
  if (!j.stages || !Array.isArray(j.stages)) continue;
  if (runIdFilter && j.runId && j.runId !== runIdFilter) continue;
  trajectories.push({ file, t: j });
}

if (trajectories.length === 0) {
  console.error(
    `[aggregate-lifeops-run] no trajectories found under ${trajectoryDir}` +
      (runIdFilter ? ` for runId=${runIdFilter}` : ""),
  );
  process.exit(1);
}

const scenariosDir = path.join(runDir, "scenarios");
fs.mkdirSync(scenariosDir, { recursive: true });
const stepsCsvPath = path.join(runDir, "steps.csv");
const reportMdPath = path.join(runDir, "report.md");

const scenarioBuckets = new Map();

const csvHeader = [
  "run_id",
  "scenario_id",
  "trajectory_id",
  "step_idx",
  "iteration",
  "retry_idx",
  "phase",
  "stage_id",
  "parent_stage_id",
  "provider",
  "model",
  "model_type",
  "started_at",
  "ended_at",
  "duration_ms",
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
  "total_input_tokens",
  "cache_hit_pct",
  "prev_step_cache_pct",
  "tool_name",
  "tool_success",
  "tool_search_top1_name",
  "tool_search_top1_score",
  "tool_search_result_count",
  "evaluator_decision",
  "error",
  "cost_usd",
].join(",");
const csvLines = [csvHeader];

function csvField(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

let scenarioOrderCounter = 0;

for (const { t } of trajectories) {
  const scenarioId = t.scenarioId ?? "(unscoped)";
  let bucket = scenarioBuckets.get(scenarioId);
  if (!bucket) {
    scenarioOrderCounter += 1;
    const slug = `${String(scenarioOrderCounter).padStart(3, "0")}-${fmtSlug(scenarioId)}`;
    const dir = path.join(scenariosDir, slug);
    fs.mkdirSync(dir, { recursive: true });
    bucket = {
      scenarioId,
      slug,
      dir,
      jsonlPath: path.join(dir, "run.jsonl"),
      metaPath: path.join(dir, "meta.json"),
      jsonlLines: [],
      trajectoryCount: 0,
      stageCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheRead: 0,
      cacheCreate: 0,
      cost: 0,
      durationMs: 0,
      phaseCounts: {},
      toolCalls: 0,
      toolFailures: 0,
      toolSearches: 0,
      cacheHitSampleCount: 0,
      cacheHitSampleSum: 0,
      lastModelStage: null,
      // report.json accumulators
      turns: [],
      reportStages: [],
      startedAt: Number.POSITIVE_INFINITY,
      endedAt: 0,
      passAt1: false,
      plannerIterations: 0,
      anyCacheReported: false,
      runIdFromTrajectory: null,
      providers: new Set(),
      modelNames: new Set(),
    };
    scenarioBuckets.set(scenarioId, bucket);
  }

  bucket.trajectoryCount += 1;
  if (t.runId && !bucket.runIdFromTrajectory) bucket.runIdFromTrajectory = t.runId;
  if (typeof t.startedAt === "number") {
    bucket.startedAt = Math.min(bucket.startedAt, t.startedAt);
  }
  if (typeof t.endedAt === "number") {
    bucket.endedAt = Math.max(bucket.endedAt, t.endedAt);
  }
  if (t.metrics?.finalDecision === "FINISH") bucket.passAt1 = true;
  let prevCachePct = 0;
  // Buffer tool calls between planner stages so they attach to the right turn.
  let currentTurn = null;
  const flushTurn = () => {
    if (currentTurn) {
      bucket.turns.push(currentTurn);
      currentTurn = null;
    }
  };

  for (let stepIdx = 0; stepIdx < t.stages.length; stepIdx += 1) {
    const s = t.stages[stepIdx];
    bucket.stageCount += 1;
    bucket.phaseCounts[s.kind] = (bucket.phaseCounts[s.kind] ?? 0) + 1;
    bucket.durationMs += safeNum(s.latencyMs);

    const usage = s.model?.usage ?? {};
    const inputTokens = safeNum(usage.promptTokens);
    const outputTokens = safeNum(usage.completionTokens);
    const cacheRead = safeNum(usage.cacheReadInputTokens);
    const cacheCreate = safeNum(usage.cacheCreationInputTokens);
    const totalInput = inputTokens + cacheRead + cacheCreate;
    const cacheHitPct = pct(cacheRead, totalInput);

    bucket.promptTokens += inputTokens;
    bucket.completionTokens += outputTokens;
    bucket.cacheRead += cacheRead;
    bucket.cacheCreate += cacheCreate;
    bucket.cost += safeNum(s.model?.costUsd);

    // Track per-call cache hit % (a sample mean over model calls), and record
    // whether the provider exposed cache fields at all (anyCacheReported).
    const usageHasCacheFields =
      usage.cacheReadInputTokens !== undefined ||
      usage.cacheCreationInputTokens !== undefined;
    if (usageHasCacheFields) bucket.anyCacheReported = true;
    if (totalInput > 0) {
      bucket.cacheHitSampleCount += 1;
      bucket.cacheHitSampleSum += cacheHitPct;
    }

    if (s.model?.provider) bucket.providers.add(s.model.provider);
    if (s.model?.modelName) bucket.modelNames.add(s.model.modelName);

    if (s.kind === "tool") {
      bucket.toolCalls += 1;
      if (s.tool && s.tool.success === false) bucket.toolFailures += 1;
      if (currentTurn) {
        currentTurn.toolCalls.push({
          name: s.tool?.name ?? "unknown",
          success: Boolean(s.tool?.success),
          durationMs: safeNum(s.tool?.durationMs ?? s.latencyMs),
          ...(s.tool?.error ? { error: String(s.tool.error) } : {}),
        });
      }
    }
    if (s.kind === "toolSearch") bucket.toolSearches += 1;

    // Append the stage to the schema-shaped `reportStages` collection. Only
    // kinds in Wave 0's `StageKind` enum land in `report.json`; the rest
    // (e.g. `messageHandler`) stay out of the schema artifact but still flow
    // into the markdown / CSV / JSONL outputs.
    const stageKindMap = {
      planner: "plannerTurn",
      tool: "toolCall",
      toolSearch: "toolSearch",
      evaluation: "evaluation",
      subPlanner: "subPlanner",
      compaction: "compaction",
      factsAndRelationships: "factsAndRelationships",
    };
    const schemaKind = stageKindMap[s.kind];
    if (schemaKind) {
      const stageObj = {
        stageId: s.stageId,
        kind: schemaKind,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        latencyMs: s.latencyMs,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? null,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
        cacheHitPct:
          totalInput > 0 ? +(cacheRead / totalInput).toFixed(4) : null,
        cacheSupported: usageHasCacheFields,
      };
      if (s.iteration !== undefined) stageObj.iteration = s.iteration;
      if (s.model?.provider) stageObj.provider = s.model.provider;
      if (s.model?.modelName) stageObj.modelName = s.model.modelName;
      if (s.model?.usage?.promptTokens !== undefined) {
        stageObj.inputTokens = inputTokens;
      }
      if (s.model?.usage?.completionTokens !== undefined) {
        stageObj.outputTokens = outputTokens;
      }
      if (s.model?.costUsd !== undefined) stageObj.costUsd = s.model.costUsd;
      if (s.tool?.name) stageObj.toolName = s.tool.name;
      if (s.tool?.success !== undefined) stageObj.toolSuccess = s.tool.success;
      if (s.tool?.error) stageObj.toolError = s.tool.error;
      if (s.cache?.prefixHash) stageObj.prefixHash = s.cache.prefixHash;
      bucket.reportStages.push(stageObj);
    }

    // Build a TurnMetrics record per planner iteration. Tool calls observed
    // between this planner stage and the next one fold into this turn.
    if (s.kind === "planner") {
      flushTurn();
      bucket.plannerIterations += 1;
      currentTurn = {
        turnIdx: bucket.turns.length,
        startedAt: s.startedAt,
        endedAt: s.endedAt,
        latencyMs: s.latencyMs,
        provider: s.model?.provider ?? "unknown",
        modelName: s.model?.modelName ?? "unknown",
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens ?? null,
        cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
        cacheHitPct:
          totalInput > 0 ? +(cacheRead / totalInput).toFixed(4) : null,
        cacheSupported: usageHasCacheFields,
        costUsd: safeNum(s.model?.costUsd),
        toolCalls: [],
        ...(s.cache?.prefixHash ? { prefixHash: s.cache.prefixHash } : {}),
      };
    } else if (currentTurn && s.kind !== "tool" && s.kind !== "toolSearch") {
      // Extend the active turn's end time so latencyMs reflects the full
      // planner→evaluation span.
      if (s.endedAt > currentTurn.endedAt) {
        currentTurn.endedAt = s.endedAt;
        currentTurn.latencyMs = currentTurn.endedAt - currentTurn.startedAt;
      }
    }

    const top = s.toolSearch?.results?.[0];
    const toolError =
      s.tool?.error ??
      (s.tool && s.tool.success === false
        ? typeof s.tool.result === "string"
          ? s.tool.result
          : JSON.stringify(s.tool.result ?? null).slice(0, 200)
        : null);

    const jsonlEntry = {
      run_id: t.runId ?? null,
      scenario: scenarioId,
      trajectory_id: t.trajectoryId,
      step_idx: stepIdx,
      iteration: s.iteration ?? null,
      retry_idx: s.retryIdx ?? null,
      phase: s.kind,
      stage_id: s.stageId,
      parent_stage_id: s.parentStageId ?? null,
      provider: s.model?.provider ?? null,
      model: s.model?.modelName ?? null,
      model_type: s.model?.modelType ?? null,
      started_at: s.startedAt,
      ended_at: s.endedAt,
      duration_ms: s.latencyMs,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_creation_input_tokens: cacheCreate,
      cache_read_input_tokens: cacheRead,
      total_input_tokens: totalInput,
      cache_hit_pct: cacheHitPct,
      prev_step_cache_pct: prevCachePct,
      tool_name: s.tool?.name ?? null,
      tool_success: s.tool ? s.tool.success : null,
      tool_search:
        s.kind === "toolSearch"
          ? {
              query: s.toolSearch?.query?.text ?? null,
              top_results: (s.toolSearch?.results ?? []).slice(0, 5).map((r) => ({
                name: r.name,
                score: r.score,
                rank: r.rank,
              })),
              tier_a: s.toolSearch?.tier?.tierA ?? [],
              tier_b: s.toolSearch?.tier?.tierB ?? [],
              fallback: s.toolSearch?.fallback ?? null,
            }
          : null,
      evaluator_decision: s.evaluation?.decision ?? null,
      error: toolError,
      cost_usd: s.model?.costUsd ?? null,
    };
    bucket.jsonlLines.push(JSON.stringify(jsonlEntry));

    csvLines.push(
      [
        csvField(t.runId),
        csvField(scenarioId),
        csvField(t.trajectoryId),
        csvField(stepIdx),
        csvField(s.iteration ?? ""),
        csvField(s.retryIdx ?? ""),
        csvField(s.kind),
        csvField(s.stageId),
        csvField(s.parentStageId ?? ""),
        csvField(s.model?.provider ?? ""),
        csvField(s.model?.modelName ?? ""),
        csvField(s.model?.modelType ?? ""),
        csvField(s.startedAt),
        csvField(s.endedAt),
        csvField(s.latencyMs),
        csvField(inputTokens),
        csvField(outputTokens),
        csvField(cacheCreate),
        csvField(cacheRead),
        csvField(totalInput),
        csvField(cacheHitPct),
        csvField(prevCachePct),
        csvField(s.tool?.name ?? ""),
        csvField(s.tool ? s.tool.success : ""),
        csvField(top?.name ?? ""),
        csvField(top?.score ?? ""),
        csvField(s.toolSearch?.results?.length ?? ""),
        csvField(s.evaluation?.decision ?? ""),
        csvField(toolError ?? ""),
        csvField(s.model?.costUsd ?? ""),
      ].join(","),
    );

    if (totalInput > 0) prevCachePct = cacheHitPct;
  }
  // Trajectory boundary: flush any pending turn into the bucket.
  flushTurn();
}

let totalStageCount = 0;
let totalPrompt = 0;
let totalCompletion = 0;
let totalCacheRead = 0;
let totalCacheCreate = 0;
let totalCost = 0;
let totalDuration = 0;

for (const b of scenarioBuckets.values()) {
  fs.writeFileSync(b.jsonlPath, b.jsonlLines.join("\n") + (b.jsonlLines.length ? "\n" : ""));
  fs.writeFileSync(
    b.metaPath,
    JSON.stringify(
      {
        scenarioId: b.scenarioId,
        slug: b.slug,
        trajectoryCount: b.trajectoryCount,
        stageCount: b.stageCount,
        phaseCounts: b.phaseCounts,
        promptTokens: b.promptTokens,
        completionTokens: b.completionTokens,
        cacheReadTokens: b.cacheRead,
        cacheCreationTokens: b.cacheCreate,
        totalInputTokens: b.promptTokens + b.cacheRead + b.cacheCreate,
        cacheHitPct: pct(b.cacheRead, b.promptTokens + b.cacheRead + b.cacheCreate),
        avgPerCallCacheHitPct: b.cacheHitSampleCount > 0
          ? +(b.cacheHitSampleSum / b.cacheHitSampleCount).toFixed(2)
          : 0,
        toolCalls: b.toolCalls,
        toolFailures: b.toolFailures,
        toolSearches: b.toolSearches,
        durationMs: b.durationMs,
        costUsd: +b.cost.toFixed(6),
      },
      null,
      2,
    ) + "\n",
  );

  totalStageCount += b.stageCount;
  totalPrompt += b.promptTokens;
  totalCompletion += b.completionTokens;
  totalCacheRead += b.cacheRead;
  totalCacheCreate += b.cacheCreate;
  totalCost += b.cost;
  totalDuration += b.durationMs;
}

fs.writeFileSync(stepsCsvPath, csvLines.join("\n") + "\n");

// Resolve run-level provider/model from the first model stage we observed in
// any scenario. This is the canonical "primary" planner model. We deliberately
// avoid a fallback string like `"unknown"` for the JSON report — if no model
// stage existed at all, validation will fail and surface the broken pipeline.
let runProvider;
let runModelName;
for (const b of scenarioBuckets.values()) {
  if (!runProvider && b.providers.size > 0) runProvider = [...b.providers][0];
  if (!runModelName && b.modelNames.size > 0) runModelName = [...b.modelNames][0];
  if (runProvider && runModelName) break;
}
const cerebrasDetected = (runProvider ?? "").toLowerCase() === "cerebras";
const anthropicDetected = (runProvider ?? "").toLowerCase() === "anthropic";
const anyCacheReportedRun = [...scenarioBuckets.values()].some(
  (b) => b.anyCacheReported,
);

let cacheSupportLine;
if (cerebrasDetected && anyCacheReportedRun) {
  cacheSupportLine = "✓ prompt cache active (Cerebras 128-token blocks)";
} else if (anthropicDetected && anyCacheReportedRun) {
  cacheSupportLine = "✓ prompt cache active (ephemeral breakpoints)";
} else if (!anyCacheReportedRun) {
  cacheSupportLine = "(provider exposes no cache info)";
} else {
  cacheSupportLine = `✓ prompt cache active (provider: ${runProvider ?? "unknown"})`;
}

const totalInput = totalPrompt + totalCacheRead + totalCacheCreate;
const lines = [
  `# LifeOps run report`,
  ``,
];

if (preReleaseFlag) {
  // When the run exercised a non-final eliza-1 bundle (any of
  // releaseState != "final", publishEligible=false, final.weights=false), the
  // aggregator stamps a banner up top so consumers cannot accidentally cite
  // these numbers as release-quality. The banner sits BEFORE the run metadata
  // block so it is the first thing every reader sees.
  lines.push(
    `> ⚠️ **PRE-RELEASE** — this run used a non-final eliza-1 bundle. Bundle metadata:`,
    `> - releaseState: local-standin`,
    `> - publishEligible: false`,
    `> - final.weights: false`,
    `> Results are NOT release-quality and MUST NOT be used in published comparisons.`,
    ``,
  );
}

lines.push(
  `**runId**: ${runIdFilter ?? "(any)"}`,
  `**runDir**: ${runDir}`,
  `**harness**: ${harness}`,
  `**provider**: ${runProvider ?? "(unknown)"}`,
  `**model**: ${runModelName ?? "(unknown)"} (${modelTierCli}${preReleaseFlag ? ", pre-release" : ""})`,
  `**cache support**: ${cacheSupportLine}`,
  `**trajectories**: ${trajectories.length}`,
  `**scenarios**: ${scenarioBuckets.size}`,
  `**total stages**: ${totalStageCount}`,
  `**total wall time**: ${(totalDuration / 1000).toFixed(2)}s`,
  ``,
  `## Token totals`,
  ``,
  `| metric | value |`,
  `| --- | ---: |`,
  `| input_tokens (uncached) | ${totalPrompt.toLocaleString()} |`,
  `| cache_creation_input_tokens | ${totalCacheCreate.toLocaleString()} |`,
  `| cache_read_input_tokens | ${totalCacheRead.toLocaleString()} |`,
  `| total_input_tokens | ${totalInput.toLocaleString()} |`,
  `| output_tokens | ${totalCompletion.toLocaleString()} |`,
  `| **cache hit %** | **${pct(totalCacheRead, totalInput)}%** |`,
  `| cost (USD) | $${totalCost.toFixed(4)} |`,
  ``,
  `## Per-scenario`,
  ``,
  `| scenario | stages | tool searches | tool calls | tool fails | input | cache read | cache hit % | output | cost | duration |`,
  `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
);

const sortedBuckets = [...scenarioBuckets.values()].sort((a, b) => b.stageCount - a.stageCount);
for (const b of sortedBuckets) {
  lines.push(
    `| \`${b.scenarioId}\` | ${b.stageCount} | ${b.toolSearches} | ${b.toolCalls} | ${b.toolFailures} | ${b.promptTokens.toLocaleString()} | ${b.cacheRead.toLocaleString()} | ${pct(b.cacheRead, b.promptTokens + b.cacheRead + b.cacheCreate)}% | ${b.completionTokens.toLocaleString()} | $${b.cost.toFixed(4)} | ${(b.durationMs / 1000).toFixed(1)}s |`,
  );
}

lines.push(``);
lines.push(`## Phase counts`);
lines.push(``);
lines.push(`| phase | count |`);
lines.push(`| --- | ---: |`);
const phaseTotals = {};
for (const b of scenarioBuckets.values()) {
  for (const [phase, count] of Object.entries(b.phaseCounts)) {
    phaseTotals[phase] = (phaseTotals[phase] ?? 0) + count;
  }
}
for (const [phase, count] of Object.entries(phaseTotals).sort((a, b) => b[1] - a[1])) {
  lines.push(`| ${phase} | ${count} |`);
}
lines.push(``);
lines.push(`Source files:`);
lines.push(`- per-scenario JSONL: \`scenarios/<idx>-<id>/run.jsonl\``);
lines.push(`- flat steps CSV: \`steps.csv\``);
lines.push(`- raw trajectories: \`${path.relative(runDir, trajectoryDir)}/\``);

fs.writeFileSync(reportMdPath, lines.join("\n") + "\n");

// ---------------------------------------------------------------------------
// report.json (Wave 0 canonical schema: lifeops-bench-v1)
// ---------------------------------------------------------------------------

const scenariosArray = [];
for (const b of [...scenarioBuckets.values()].sort((a, b) =>
  a.slug.localeCompare(b.slug),
)) {
  const totalInputScenario = b.promptTokens + b.cacheRead + b.cacheCreate;
  const startedAt = Number.isFinite(b.startedAt) ? b.startedAt : 0;
  const endedAt = b.endedAt > 0 ? b.endedAt : startedAt + b.durationMs;
  const aggregateCacheHitPct = b.anyCacheReported
    ? totalInputScenario > 0
      ? +(b.cacheRead / totalInputScenario).toFixed(4)
      : 0
    : null;
  const run = {
    runId: b.runIdFromTrajectory ?? runIdFilter ?? "(unscoped)",
    scenarioId: b.scenarioId,
    harness,
    provider: runProvider ?? "unknown",
    modelName: runModelName ?? "unknown",
    modelTier: modelTierCli,
    preRelease: preReleaseFlag,
    passAt1: b.passAt1,
    startedAt,
    endedAt,
    timeToCompleteMs: Math.max(0, endedAt - startedAt),
    turns: b.turns,
    stages: b.reportStages,
    totalInputTokens: b.promptTokens + b.cacheRead + b.cacheCreate,
    totalOutputTokens: b.completionTokens,
    totalCacheReadTokens: b.anyCacheReported ? b.cacheRead : null,
    totalCacheCreationTokens: b.anyCacheReported ? b.cacheCreate : null,
    aggregateCacheHitPct,
    totalCostUsd: +b.cost.toFixed(6),
    plannerIterations: b.plannerIterations,
    toolCallCount: b.toolCalls,
    toolFailureCount: b.toolFailures,
  };
  scenariosArray.push(run);
}

const passCount = scenariosArray.filter((s) => s.passAt1).length;
const aggregateCacheHitPctRun = anyCacheReportedRun
  ? totalInput > 0
    ? +(totalCacheRead / totalInput).toFixed(4)
    : 0
  : null;
const rollup = {
  scenarioCount: scenariosArray.length,
  passCount,
  passRate:
    scenariosArray.length > 0
      ? +(passCount / scenariosArray.length).toFixed(4)
      : 0,
  totalInputTokens: totalInput,
  totalOutputTokens: totalCompletion,
  totalCacheReadTokens: anyCacheReportedRun ? totalCacheRead : null,
  aggregateCacheHitPct: aggregateCacheHitPctRun,
  totalCostUsd: +totalCost.toFixed(6),
  totalTimeMs: totalDuration,
};

const notes = [];
if (cerebrasDetected) {
  notes.push(
    "cerebras prompt caching supported via prompt_tokens_details.cached_tokens",
  );
}
if (!anyCacheReportedRun) {
  notes.push("provider does not expose cache info");
}

const reportPayload = {
  schemaVersion: REPORT_SCHEMA_VERSION,
  generatedAt: new Date().toISOString(),
  runId: runIdFilter ?? scenariosArray[0]?.runId ?? "(unscoped)",
  harness,
  provider: runProvider ?? "unknown",
  modelName: runModelName ?? "unknown",
  modelTier: modelTierCli,
  preRelease: preReleaseFlag,
  scenarios: scenariosArray,
  rollup,
  ...(notes.length > 0 ? { notes } : {}),
};

const parseResult = ReportSchema.safeParse(reportPayload);
if (!parseResult.success) {
  const issues = parseResult.error.issues
    .map((iss) => `  - ${iss.path.join(".") || "(root)"}: ${iss.message}`)
    .join("\n");
  throw new Error(
    `[aggregate-lifeops-run] report.json failed schema validation:\n${issues}`,
  );
}

const reportJsonPath = path.join(runDir, "report.json");
fs.writeFileSync(reportJsonPath, JSON.stringify(parseResult.data, null, 2) + "\n");

process.stdout.write(
  `[aggregate-lifeops-run] wrote ${reportMdPath}\n` +
    `[aggregate-lifeops-run] wrote ${reportJsonPath}\n` +
    `[aggregate-lifeops-run] wrote ${stepsCsvPath}\n` +
    `[aggregate-lifeops-run] wrote ${scenarioBuckets.size} scenario bundles under ${scenariosDir}\n`,
);
