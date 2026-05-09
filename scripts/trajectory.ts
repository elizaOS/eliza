#!/usr/bin/env bun
/**
 * `trajectory` — read-only CLI for inspecting the per-trajectory JSON files
 * the runtime recorder writes to `${MILADY_TRAJECTORY_DIR}` (default
 * `./trajectories/`).
 *
 * Spec lives in `research/native-tool-calling/PLAN.md` §18.3.
 *
 * The schema this CLI reads matches `RecordedTrajectory` / `RecordedStage` in
 * §18.1. Agent B owns the runtime side that produces the files; this tool
 * never imports from `runtime/trajectory-recorder.ts` so it stays usable when
 * that side hasn't landed yet. The schema is duplicated here verbatim from
 * the plan as a typed contract.
 *
 * Subcommands:
 *   list       - Tabular index of trajectories.
 *   print      - Full per-stage transcript.
 *   stats      - Compact metrics summary.
 *   failures   - Filter to stages where success === false.
 *   diff       - Byte/segment diff of prompts between two stages.
 *   replay     - Print the prompt that was sent at a given stage.
 *   export     - Write a self-contained markdown/html/json report.
 *   validate   - Structural validation for complete, reviewable trajectories.
 *   compare    - Cache/batching/cost deltas between two trajectories.
 *   aggregate  - Cross-trajectory rollup.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { computeCallCostUsd, formatUsd } from "./lib/cost-table";
import {
  compareTrajectories,
  type ValidationIssue,
  validateTrajectory,
  validateTrajectoryExportReport,
} from "./lib/trajectory-validate";

// ---------------------------------------------------------------------------
// Schema (mirrors PLAN.md §18.1; do not import — Agent B owns the producer)
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: string;
  content: unknown;
}

interface ToolDefinition {
  name?: string;
  description?: string;
  [key: string]: unknown;
}

interface ToolCallRecord {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
  [key: string]: unknown;
}

interface UsageBreakdown {
  promptTokens: number;
  completionTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  totalTokens: number;
}

interface ModelCallRecord {
  modelType: string;
  modelName?: string;
  provider: string;
  prompt?: string;
  messages?: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: unknown;
  response: string;
  toolCalls?: ToolCallRecord[];
  usage?: UsageBreakdown;
  finishReason?: string;
  costUsd?: number;
}

interface ToolStageRecord {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
  durationMs: number;
}

interface EvaluationRecord {
  success: boolean;
  decision: string;
  thought?: string;
  messageToUser?: string;
  copyToClipboard?: unknown;
  recommendedToolCallId?: string;
  [key: string]: unknown;
}

interface CacheStageRecord {
  segmentHashes: string[];
  prefixHash: string;
  diffFromPriorStage?: { added: number; unchanged: number; removed: number };
}

interface RecordedStage {
  stageId: string;
  kind:
    | "messageHandler"
    | "planner"
    | "tool"
    | "evaluation"
    | "subPlanner"
    | "compaction"
    | "factsAndRelationships";
  iteration?: number;
  parentStageId?: string;
  startedAt: number;
  endedAt: number;
  latencyMs: number;
  model?: ModelCallRecord;
  tool?: ToolStageRecord;
  evaluation?: EvaluationRecord;
  cache?: CacheStageRecord;
}

interface RecordedTrajectoryMetrics {
  totalLatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalCostUsd: number;
  plannerIterations: number;
  toolCallsExecuted: number;
  toolCallFailures: number;
  evaluatorFailures: number;
  finalDecision?: "FINISH" | "CONTINUE" | "max_iterations" | "error";
}

interface RecordedTrajectory {
  trajectoryId: string;
  agentId: string;
  roomId?: string;
  rootMessage: { id: string; text: string; sender?: string };
  startedAt: number;
  endedAt?: number;
  status: "running" | "finished" | "errored";
  stages: RecordedStage[];
  metrics: RecordedTrajectoryMetrics;
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

const TRAJECTORY_DIR =
  process.env.MILADY_TRAJECTORY_DIR ??
  path.resolve(process.cwd(), "trajectories");

interface TrajectoryFile {
  id: string;
  filePath: string;
  mtimeMs: number;
}

async function listTrajectoryFiles(): Promise<TrajectoryFile[]> {
  const out: TrajectoryFile[] = [];
  const stack: string[] = [TRAJECTORY_DIR];

  try {
    await fs.access(TRAJECTORY_DIR);
  } catch {
    return out;
  }

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: Dirent[];
    try {
      entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[];
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      let mtimeMs = 0;
      try {
        const stat = await fs.stat(full);
        mtimeMs = stat.mtimeMs;
      } catch {
        continue;
      }
      out.push({
        id: entry.name.replace(/\.json$/, ""),
        filePath: full,
        mtimeMs,
      });
    }
  }

  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

async function loadTrajectory(
  idOrPath: string,
): Promise<{ trajectory: RecordedTrajectory; filePath: string } | null> {
  // Try direct path first.
  if (idOrPath.endsWith(".json")) {
    try {
      const raw = await fs.readFile(idOrPath, "utf8");
      return { trajectory: JSON.parse(raw), filePath: idOrPath };
    } catch {
      // fall through
    }
  }

  const files = await listTrajectoryFiles();
  const match = files.find((f) => f.id === idOrPath);
  if (!match) return null;
  const raw = await fs.readFile(match.filePath, "utf8");
  return { trajectory: JSON.parse(raw), filePath: match.filePath };
}

// ---------------------------------------------------------------------------
// Pretty-printing helpers
// ---------------------------------------------------------------------------

function ttyEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  const argv = process.argv;
  if (argv.includes("--no-tty")) return false;
  return process.stdout.isTTY === true;
}

function color(code: string, text: string): string {
  if (!ttyEnabled()) return text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

const c = {
  dim: (t: string) => color("2", t),
  bold: (t: string) => color("1", t),
  red: (t: string) => color("31", t),
  green: (t: string) => color("32", t),
  yellow: (t: string) => color("33", t),
  cyan: (t: string) => color("36", t),
  gray: (t: string) => color("90", t),
};

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toISOString().replace("T", " ").replace(/\..+$/, "");
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}${c.dim("…")}`;
}

function stringifyModelContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function modelInputTranscript(model: ModelCallRecord | undefined): string {
  if (!model) return "";
  if (typeof model.prompt === "string" && model.prompt.trim().length > 0) {
    return model.prompt;
  }
  if (!Array.isArray(model.messages)) return "";
  return model.messages
    .map((message, index) => {
      const role =
        typeof message.role === "string" && message.role.trim()
          ? message.role
          : `message[${index}]`;
      return `${role}: ${stringifyModelContent(message.content)}`;
    })
    .filter((line) => line.trim().length > 0)
    .join("\n\n");
}

function matchesStage(stage: RecordedStage, idOrKind: string): boolean {
  return stage.stageId === idOrKind || stage.kind === idOrKind;
}

function stageHeader(stage: RecordedStage, index: number): string {
  const kindLabel = stage.kind;
  const iter = stage.iteration ? ` iter ${stage.iteration}` : "";
  const toolName = stage.tool ? `: ${stage.tool.name}` : "";

  const lat = formatDuration(stage.latencyMs);
  const cost = stage.model?.costUsd
    ? ` · ${formatUsd(stage.model.costUsd)}`
    : "";
  const usage = stage.model?.usage;
  const cacheNote = usage?.cacheReadInputTokens
    ? ` · cache hit ${usage.cacheReadInputTokens}/${usage.promptTokens} tokens`
    : "";

  return c.bold(
    `Stage ${index + 1} [${kindLabel}${iter}${toolName}] ${lat}${cost}${cacheNote}`,
  );
}

function rule(): string {
  return c.dim("─".repeat(72));
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

interface ListOptions {
  agent?: string;
  since?: number;
  limit?: number;
}

async function cmdList(opts: ListOptions): Promise<void> {
  const files = await listTrajectoryFiles();
  if (files.length === 0) {
    console.log(c.dim(`No trajectories found in ${TRAJECTORY_DIR}.`));
    return;
  }

  const rows: Array<{
    id: string;
    started: string;
    duration: string;
    stages: number;
    tools: number;
    cost: string;
    decision: string;
    agent: string;
  }> = [];

  for (const file of files.slice(0, opts.limit ?? 20)) {
    try {
      const raw = await fs.readFile(file.filePath, "utf8");
      const traj = JSON.parse(raw) as RecordedTrajectory;

      if (opts.agent && traj.agentId !== opts.agent) continue;
      if (opts.since && (traj.startedAt ?? 0) < opts.since) continue;

      const decision = traj.metrics?.finalDecision ?? traj.status;
      rows.push({
        id: traj.trajectoryId,
        started: formatTimestamp(traj.startedAt),
        duration: formatDuration(traj.metrics?.totalLatencyMs ?? 0),
        stages: traj.stages.length,
        tools: traj.metrics?.toolCallsExecuted ?? 0,
        cost: formatUsd(traj.metrics?.totalCostUsd ?? 0),
        decision,
        agent: traj.agentId ?? "—",
      });
    } catch (err) {
      console.error(
        c.yellow(`skip ${file.filePath}: ${(err as Error).message}`),
      );
    }
  }

  if (rows.length === 0) {
    console.log(c.dim("No trajectories matched the filter."));
    return;
  }

  const widths = {
    id: Math.max(2, ...rows.map((r) => r.id.length), 12),
    started: 19,
    duration: 8,
    stages: 6,
    tools: 5,
    cost: 8,
    decision: Math.max(8, ...rows.map((r) => r.decision.length)),
    agent: Math.max(8, ...rows.map((r) => r.agent.length)),
  };

  const header = `${"id".padEnd(widths.id)}  ${"started".padEnd(widths.started)}  ${"dur".padEnd(widths.duration)}  ${"stages".padEnd(widths.stages)}  ${"tools".padEnd(widths.tools)}  ${"cost".padEnd(widths.cost)}  ${"decision".padEnd(widths.decision)}  ${"agent".padEnd(widths.agent)}`;
  console.log(c.bold(header));
  console.log(c.dim("-".repeat(header.length)));
  for (const row of rows) {
    console.log(
      `${row.id.padEnd(widths.id)}  ${row.started.padEnd(widths.started)}  ${row.duration.padEnd(widths.duration)}  ${String(row.stages).padEnd(widths.stages)}  ${String(row.tools).padEnd(widths.tools)}  ${row.cost.padEnd(widths.cost)}  ${row.decision.padEnd(widths.decision)}  ${row.agent.padEnd(widths.agent)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Subcommand: print
// ---------------------------------------------------------------------------

interface PrintOptions {
  stageId?: string;
  full: boolean;
}

function printStage(
  stage: RecordedStage,
  idx: number,
  opts: PrintOptions,
): void {
  const promptLimit = opts.full ? Number.POSITIVE_INFINITY : 2000;
  const responseLimit = opts.full ? Number.POSITIVE_INFINITY : 2000;

  console.log(stageHeader(stage, idx));
  console.log(rule());

  if (stage.model) {
    const m = stage.model;
    const usage = m.usage;
    console.log(
      `${c.dim("model:")}    ${m.modelName ?? m.modelType} ${c.dim(`(${m.provider})`)}`,
    );
    if (usage) {
      console.log(
        `${c.dim("usage:")}    ${usage.promptTokens} in · ${usage.completionTokens} out` +
          (usage.cacheReadInputTokens
            ? ` · ${usage.cacheReadInputTokens} cache-read`
            : "") +
          (usage.cacheCreationInputTokens
            ? ` · ${usage.cacheCreationInputTokens} cache-create`
            : ""),
      );
    }
    if (m.tools && m.tools.length > 0) {
      console.log(
        `${c.dim("tools:")}    ${m.tools.map((t) => t.name ?? "<anon>").join(", ")}`,
      );
    }
    const modelInput = modelInputTranscript(m);
    if (modelInput) {
      console.log(c.dim(m.prompt ? "prompt:" : "messages:"));
      console.log(truncate(modelInput, promptLimit));
    }
    if (m.response) {
      console.log(c.dim("response:"));
      console.log(truncate(m.response, responseLimit));
    }
    if (m.toolCalls && m.toolCalls.length > 0) {
      console.log(c.dim("toolCalls:"));
      for (const call of m.toolCalls) {
        console.log(
          `  ${c.cyan(call.name ?? "<no-name>")} ${JSON.stringify(call.args ?? {})}`,
        );
      }
    }
  }

  if (stage.tool) {
    const t = stage.tool;
    const tag = t.success ? c.green("success") : c.red("FAILURE");
    console.log(
      `${c.dim("tool:")}     ${t.name} · ${tag} · ${formatDuration(t.durationMs)}`,
    );
    console.log(`${c.dim("args:")}     ${JSON.stringify(t.args)}`);
    console.log(
      `${c.dim("result:")}   ${truncate(JSON.stringify(t.result), opts.full ? Number.POSITIVE_INFINITY : 1500)}`,
    );
  }

  if (stage.evaluation) {
    const e = stage.evaluation;
    const tag = e.success ? c.green("success: true") : c.red("success: false");
    console.log(
      `${c.dim("eval:")}     ${tag} · decision: ${c.cyan(e.decision)}`,
    );
    if (e.thought) console.log(`${c.dim("thought:")}  ${e.thought}`);
    if (e.messageToUser)
      console.log(`${c.dim("user:")}     ${e.messageToUser}`);
  }

  if (stage.cache?.diffFromPriorStage) {
    const d = stage.cache.diffFromPriorStage;
    console.log(
      `${c.dim("cache:")}    +${d.added} ~${d.unchanged} -${d.removed} segments`,
    );
  }

  console.log("");
}

async function cmdPrint(idOrPath: string, opts: PrintOptions): Promise<void> {
  const loaded = await loadTrajectory(idOrPath);
  if (!loaded) {
    console.error(c.red(`No trajectory found for "${idOrPath}".`));
    process.exitCode = 1;
    return;
  }
  const t = loaded.trajectory;

  console.log(c.bold(`Trajectory ${t.trajectoryId}`));
  console.log(
    `${c.dim("agent:")}  ${t.agentId}  ${c.dim("room:")} ${t.roomId ?? "—"}`,
  );
  console.log(
    `${c.dim("from:")}   ${t.rootMessage?.sender ?? "user"}: ${t.rootMessage?.text ?? "—"}`,
  );
  console.log(
    `${c.dim("status:")} ${t.status}  ${c.dim("started:")} ${formatTimestamp(t.startedAt)}  ${c.dim("ended:")} ${t.endedAt ? formatTimestamp(t.endedAt) : "—"}`,
  );
  console.log(
    `${c.dim("metrics:")} ${formatDuration(t.metrics?.totalLatencyMs ?? 0)} · ${formatUsd(t.metrics?.totalCostUsd ?? 0)} · stages ${t.stages.length} · tool calls ${t.metrics?.toolCallsExecuted ?? 0} · final ${t.metrics?.finalDecision ?? "—"}`,
  );
  console.log("");

  const stages = opts.stageId
    ? t.stages.filter((s) => matchesStage(s, opts.stageId ?? ""))
    : t.stages;
  if (opts.stageId && stages.length === 0) {
    console.error(c.red(`Stage "${opts.stageId}" not found in trajectory.`));
    process.exitCode = 1;
    return;
  }

  stages.forEach((stage, idx) => {
    printStage(stage, idx, opts);
  });
}

// ---------------------------------------------------------------------------
// Subcommand: stats
// ---------------------------------------------------------------------------

async function cmdStats(idOrPath: string): Promise<void> {
  const loaded = await loadTrajectory(idOrPath);
  if (!loaded) {
    console.error(c.red(`No trajectory found for "${idOrPath}".`));
    process.exitCode = 1;
    return;
  }
  const t = loaded.trajectory;
  const m = t.metrics;

  const stageCounts = new Map<string, number>();
  for (const s of t.stages) {
    stageCounts.set(s.kind, (stageCounts.get(s.kind) ?? 0) + 1);
  }
  const stageBreakdown = Array.from(stageCounts.entries())
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");

  const decisionCounts = new Map<string, number>();
  for (const s of t.stages) {
    if (s.evaluation?.decision) {
      decisionCounts.set(
        s.evaluation.decision,
        (decisionCounts.get(s.evaluation.decision) ?? 0) + 1,
      );
    }
  }
  const decisionList = Array.from(decisionCounts.entries())
    .map(([k, v]) => `${k} (${v})`)
    .join(", ");

  const cacheRates: number[] = [];
  for (const s of t.stages) {
    if (s.model?.usage && s.model.usage.promptTokens > 0) {
      cacheRates.push(
        (s.model.usage.cacheReadInputTokens ?? 0) /
          Math.max(1, s.model.usage.promptTokens),
      );
    }
  }
  const meanCacheRate = cacheRates.length
    ? (cacheRates.reduce((a, b) => a + b, 0) / cacheRates.length) * 100
    : 0;

  console.log(c.bold(`Trajectory ${t.trajectoryId}`));
  console.log(
    `agent ${t.agentId} · started ${formatTimestamp(t.startedAt)} · ${formatDuration(m?.totalLatencyMs ?? 0)} total`,
  );
  console.log(`Stages: ${t.stages.length} (${stageBreakdown || "—"})`);
  console.log(
    `Tokens: ${m?.totalPromptTokens ?? 0} input (${m?.totalCacheReadTokens ?? 0} cache-read, ${m?.totalCacheCreationTokens ?? 0} cache-created), ${m?.totalCompletionTokens ?? 0} output`,
  );
  console.log(`Cost: ${formatUsd(m?.totalCostUsd ?? 0)}`);
  console.log(
    `Tool calls: ${m?.toolCallsExecuted ?? 0} executed (${(m?.toolCallsExecuted ?? 0) - (m?.toolCallFailures ?? 0)} success, ${m?.toolCallFailures ?? 0} failed)`,
  );
  console.log(`Evaluator decisions: ${decisionList || "—"}`);
  console.log(
    `Terminal evaluator failures: ${m?.evaluatorFailures ?? 0} stages`,
  );
  console.log(`Cache hit rate (avg): ${meanCacheRate.toFixed(1)}%`);
}

// ---------------------------------------------------------------------------
// Subcommand: failures
// ---------------------------------------------------------------------------

async function cmdFailures(idOrPath: string): Promise<void> {
  const loaded = await loadTrajectory(idOrPath);
  if (!loaded) {
    console.error(c.red(`No trajectory found for "${idOrPath}".`));
    process.exitCode = 1;
    return;
  }
  const t = loaded.trajectory;
  const failed = t.stages.filter(
    (s) => s.tool?.success === false || s.evaluation?.success === false,
  );

  if (failed.length === 0) {
    console.log(c.green(`No failed stages in trajectory ${t.trajectoryId}.`));
    return;
  }

  console.log(
    c.bold(
      `Trajectory ${t.trajectoryId} · ${failed.length} failed ${failed.length === 1 ? "stage" : "stages"}`,
    ),
  );
  console.log("");

  for (const stage of failed) {
    printStage(stage, t.stages.indexOf(stage), {
      full: true,
      stageId: undefined,
    });
  }
}

// ---------------------------------------------------------------------------
// Subcommand: diff
// ---------------------------------------------------------------------------

interface DiffOptions {
  stages: [string, string];
}

async function cmdDiff(idOrPath: string, opts: DiffOptions): Promise<void> {
  const loaded = await loadTrajectory(idOrPath);
  if (!loaded) {
    console.error(c.red(`No trajectory found for "${idOrPath}".`));
    process.exitCode = 1;
    return;
  }
  const t = loaded.trajectory;
  const a = t.stages.find((s) => s.stageId === opts.stages[0]);
  const b = t.stages.find((s) => s.stageId === opts.stages[1]);
  if (!a || !b) {
    console.error(
      c.red(
        `Stage(s) not found. a=${opts.stages[0]} (${a ? "ok" : "missing"}), b=${opts.stages[1]} (${b ? "ok" : "missing"})`,
      ),
    );
    process.exitCode = 1;
    return;
  }

  console.log(c.bold("Stage A"));
  console.log(
    `  ${a.stageId}  ${a.kind}${a.iteration ? ` iter ${a.iteration}` : ""}`,
  );
  console.log(c.bold("Stage B"));
  console.log(
    `  ${b.stageId}  ${b.kind}${b.iteration ? ` iter ${b.iteration}` : ""}`,
  );
  console.log("");

  const promptA = modelInputTranscript(a.model);
  const promptB = modelInputTranscript(b.model);

  let common = 0;
  const min = Math.min(promptA.length, promptB.length);
  for (; common < min; common++) {
    if (promptA[common] !== promptB[common]) break;
  }
  console.log(
    `Common prefix: ${common} chars (~${Math.round(common / 4)} tokens)`,
  );
  console.log(
    `A length: ${promptA.length} chars · B length: ${promptB.length} chars`,
  );

  if (a.cache && b.cache) {
    const aSet = new Set(a.cache.segmentHashes);
    const bSet = new Set(b.cache.segmentHashes);
    const added = b.cache.segmentHashes.filter((h) => !aSet.has(h));
    const removed = a.cache.segmentHashes.filter((h) => !bSet.has(h));
    const unchanged = a.cache.segmentHashes.filter((h) => bSet.has(h));
    console.log(
      `Segment-level: +${added.length} added, ~${unchanged.length} unchanged, -${removed.length} removed`,
    );
  }

  const tail = promptB.slice(common);
  if (tail.length > 0) {
    console.log("");
    console.log(c.dim("B-only suffix (truncated):"));
    console.log(truncate(tail, 1000));
  }
  console.log("");
  console.log(
    c.dim("Cache implication: B can hit A's cached prefix where shared."),
  );
}

// ---------------------------------------------------------------------------
// Subcommand: replay
// ---------------------------------------------------------------------------

async function cmdReplay(idOrPath: string, stageId?: string): Promise<void> {
  const loaded = await loadTrajectory(idOrPath);
  if (!loaded) {
    console.error(c.red(`No trajectory found for "${idOrPath}".`));
    process.exitCode = 1;
    return;
  }
  const t = loaded.trajectory;
  const stage = stageId
    ? t.stages.find((s) => matchesStage(s, stageId))
    : t.stages.find((s) => modelInputTranscript(s.model).length > 0);

  if (!stage) {
    console.error(c.red("No matching stage with model input."));
    process.exitCode = 1;
    return;
  }
  const input = modelInputTranscript(stage.model);
  if (!input) {
    console.error(c.red(`Stage ${stage.stageId} has no recorded model input.`));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(input);
  if (!input.endsWith("\n")) process.stdout.write("\n");
}

// ---------------------------------------------------------------------------
// Subcommand: export
// ---------------------------------------------------------------------------

interface ExportOptions {
  format: "markdown" | "html" | "json";
  out?: string;
}

function exportMarkdown(t: RecordedTrajectory): string {
  const lines: string[] = [];
  lines.push(`# Trajectory ${t.trajectoryId}`);
  lines.push("");
  lines.push(`- agent: \`${t.agentId}\``);
  lines.push(`- room: \`${t.roomId ?? "—"}\``);
  lines.push(`- started: ${formatTimestamp(t.startedAt)}`);
  lines.push(`- ended: ${t.endedAt ? formatTimestamp(t.endedAt) : "—"}`);
  lines.push(`- status: ${t.status}`);
  lines.push(
    `- total: ${formatDuration(t.metrics?.totalLatencyMs ?? 0)} · ${formatUsd(t.metrics?.totalCostUsd ?? 0)}`,
  );
  lines.push(`- root message: ${t.rootMessage?.text ?? "—"}`);
  lines.push("");

  t.stages.forEach((stage, idx) => {
    lines.push(
      `## Stage ${idx + 1}: ${stage.kind}${stage.iteration ? ` iter ${stage.iteration}` : ""} (${stage.stageId})`,
    );
    lines.push("");
    lines.push(`- latency: ${formatDuration(stage.latencyMs)}`);
    if (stage.model) {
      lines.push(
        `- model: \`${stage.model.modelName ?? stage.model.modelType}\` (${stage.model.provider})`,
      );
      if (stage.model.usage) {
        lines.push(
          `- usage: ${stage.model.usage.promptTokens} in · ${stage.model.usage.completionTokens} out · cache-read ${stage.model.usage.cacheReadInputTokens ?? 0}`,
        );
      }
      const input = modelInputTranscript(stage.model);
      lines.push("```");
      lines.push("PROMPT:");
      lines.push(input);
      lines.push("");
      lines.push("RESPONSE:");
      lines.push(stage.model.response);
      lines.push("```");
      lines.push("");
      lines.push("```");
      lines.push("MESSAGES:");
      lines.push(JSON.stringify(stage.model.messages ?? [], null, 2));
      lines.push("TOOLS:");
      lines.push(JSON.stringify(stage.model.tools ?? [], null, 2));
      lines.push("TOOL_CALLS:");
      lines.push(JSON.stringify(stage.model.toolCalls ?? [], null, 2));
      lines.push("```");
    }
    if (stage.tool) {
      lines.push(
        `- tool \`${stage.tool.name}\` ${stage.tool.success ? "ok" : "FAIL"} ${formatDuration(stage.tool.durationMs)}`,
      );
      lines.push("```json");
      lines.push(
        JSON.stringify(
          { args: stage.tool.args, result: stage.tool.result },
          null,
          2,
        ),
      );
      lines.push("```");
    }
    if (stage.evaluation) {
      lines.push(
        `- evaluation: success=${stage.evaluation.success}, decision=${stage.evaluation.decision}`,
      );
      if (stage.evaluation.thought)
        lines.push(`  - thought: ${stage.evaluation.thought}`);
      if (stage.evaluation.messageToUser)
        lines.push(`  - messageToUser: ${stage.evaluation.messageToUser}`);
    }
    lines.push("");
  });

  return lines.join("\n");
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function exportHtml(t: RecordedTrajectory): string {
  const stages = t.stages
    .map((stage, idx) => {
      const input = modelInputTranscript(stage.model);
      const promptBlock = input
        ? `<details><summary>input (${input.length} chars)</summary><pre>${htmlEscape(input)}</pre></details>`
        : "";
      const responseBlock = stage.model?.response
        ? `<details><summary>response</summary><pre>${htmlEscape(stage.model.response)}</pre></details>`
        : "";
      const toolBlock = stage.tool
        ? `<pre>tool ${htmlEscape(stage.tool.name)} ${stage.tool.success ? "ok" : "FAIL"}\nargs: ${htmlEscape(JSON.stringify(stage.tool.args))}\nresult: ${htmlEscape(JSON.stringify(stage.tool.result))}</pre>`
        : "";
      const evalBlock = stage.evaluation
        ? `<pre>eval success=${stage.evaluation.success} decision=${htmlEscape(stage.evaluation.decision)}\n${htmlEscape(stage.evaluation.thought ?? "")}</pre>`
        : "";
      return `<section><h2>Stage ${idx + 1}: ${htmlEscape(stage.kind)}${stage.iteration ? ` iter ${stage.iteration}` : ""}</h2><p>${formatDuration(stage.latencyMs)}</p>${promptBlock}${responseBlock}${toolBlock}${evalBlock}</section>`;
    })
    .join("\n");

  return `<!doctype html><html><head><meta charset="utf-8"><title>${htmlEscape(t.trajectoryId)}</title><style>body{font-family:system-ui,sans-serif;max-width:960px;margin:2em auto;padding:0 1em}pre{white-space:pre-wrap;background:#f4f4f4;padding:0.5em;border-radius:4px}h2{margin-top:2em;border-bottom:1px solid #ddd;padding-bottom:0.2em}</style></head><body><h1>Trajectory ${htmlEscape(t.trajectoryId)}</h1><p>agent: ${htmlEscape(t.agentId)} · ${formatDuration(t.metrics?.totalLatencyMs ?? 0)} · ${formatUsd(t.metrics?.totalCostUsd ?? 0)}</p>${stages}</body></html>`;
}

async function cmdExport(idOrPath: string, opts: ExportOptions): Promise<void> {
  const loaded = await loadTrajectory(idOrPath);
  if (!loaded) {
    console.error(c.red(`No trajectory found for "${idOrPath}".`));
    process.exitCode = 1;
    return;
  }
  const t = loaded.trajectory;
  let body: string;
  if (opts.format === "markdown") body = exportMarkdown(t);
  else if (opts.format === "html") body = exportHtml(t);
  else body = JSON.stringify(t, null, 2);

  if (opts.format === "markdown" || opts.format === "json") {
    const reportValidation = validateTrajectoryExportReport(
      opts.format,
      body,
      t,
    );
    if (!reportValidation.ok) {
      printValidationIssues(reportValidation.issues);
      throw new Error(`export ${opts.format} report validation failed`);
    }
  }

  if (opts.out) {
    await fs.writeFile(opts.out, body, "utf8");
    console.log(c.dim(`Wrote ${opts.out} (${body.length} bytes).`));
  } else {
    process.stdout.write(body);
    if (!body.endsWith("\n")) process.stdout.write("\n");
  }
}

// ---------------------------------------------------------------------------
// Subcommand: validate
// ---------------------------------------------------------------------------

interface ValidateOptions {
  expectedStages?: string[];
  expectedContexts?: string[];
  json: boolean;
  strictMessages: boolean;
}

function printValidationIssues(issues: ValidationIssue[]): void {
  for (const issue of issues) {
    const label =
      issue.severity === "error" ? c.red("error") : c.yellow("warning");
    console.error(`${label} ${issue.path}: ${issue.message}`);
  }
}

async function cmdValidate(
  idOrPath: string,
  opts: ValidateOptions,
): Promise<void> {
  const loaded = await loadTrajectory(idOrPath);
  if (!loaded) {
    console.error(c.red(`No trajectory found for "${idOrPath}".`));
    process.exitCode = 1;
    return;
  }

  const result = validateTrajectory(loaded.trajectory, {
    expectedStages: opts.expectedStages,
    expectedContexts: opts.expectedContexts,
    requireMessageArrays: opts.strictMessages,
  });

  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2));
    process.stdout.write("\n");
  } else {
    const status = result.ok ? c.green("ok") : c.red("failed");
    console.log(
      `${c.bold(`Trajectory ${loaded.trajectory.trajectoryId}`)} validation ${status}`,
    );
    console.log(
      `Stages: ${result.stageKinds.join(" -> ") || "—"} · model calls ${result.rollup.modelCallStages} · tools ${result.rollup.toolCallsExecuted} (${result.rollup.toolResultSuccesses} success, ${result.rollup.toolResultFailures} failed)`,
    );
    console.log(
      `Tokens: ${result.rollup.totalPromptTokens} in, ${result.rollup.totalCompletionTokens} out, ${result.rollup.totalCacheReadTokens} cache-read, ${result.rollup.totalCacheCreationTokens} cache-created`,
    );
    console.log(
      `Evaluators: ${result.rollup.evaluatorStages} (${result.rollup.evaluatorSuccesses} success, ${result.rollup.evaluatorFailures} failed) · Cost: ${formatUsd(result.rollup.totalCostUsd)}`,
    );
    if (result.selectedContexts.length > 0) {
      console.log(`Contexts: ${result.selectedContexts.join(", ")}`);
    }
    if (result.issues.length > 0) {
      console.log("");
      printValidationIssues(result.issues);
    }
  }

  if (!result.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Subcommand: compare
// ---------------------------------------------------------------------------

async function cmdCompare(
  idA: string,
  idB: string,
  asJson: boolean,
): Promise<void> {
  const loadedA = await loadTrajectory(idA);
  const loadedB = await loadTrajectory(idB);
  if (!loadedA || !loadedB) {
    if (!loadedA) console.error(c.red(`No trajectory found for "${idA}".`));
    if (!loadedB) console.error(c.red(`No trajectory found for "${idB}".`));
    process.exitCode = 1;
    return;
  }

  const summary = compareTrajectories(loadedA.trajectory, loadedB.trajectory);
  if (asJson) {
    process.stdout.write(JSON.stringify(summary, null, 2));
    process.stdout.write("\n");
    return;
  }

  const fmtDelta = (n: number, suffix = "") =>
    `${n >= 0 ? "+" : ""}${Number.isInteger(n) ? n : n.toFixed(6)}${suffix}`;
  console.log(c.bold(`Compare ${summary.idA} -> ${summary.idB}`));
  console.log(
    `Cost: ${formatUsd(summary.a.totalCostUsd)} -> ${formatUsd(summary.b.totalCostUsd)} (${fmtDelta(summary.delta.totalCostUsd, " USD")})`,
  );
  console.log(
    `Prompt tokens: ${summary.a.totalPromptTokens} -> ${summary.b.totalPromptTokens} (${fmtDelta(summary.delta.totalPromptTokens)})`,
  );
  console.log(
    `Completion tokens: ${summary.a.totalCompletionTokens} -> ${summary.b.totalCompletionTokens} (${fmtDelta(summary.delta.totalCompletionTokens)})`,
  );
  console.log(
    `Cache read tokens: ${summary.a.totalCacheReadTokens} -> ${summary.b.totalCacheReadTokens} (${fmtDelta(summary.delta.totalCacheReadTokens)})`,
  );
  console.log(
    `Cache hit rate: ${(summary.cacheHitRateA * 100).toFixed(1)}% -> ${(summary.cacheHitRateB * 100).toFixed(1)}% (${fmtDelta(summary.cacheHitRateDelta * 100, " pp")})`,
  );
  console.log(
    `Batching proxy: model calls ${summary.a.modelCallStages} -> ${summary.b.modelCallStages} (${fmtDelta(summary.estimatedBatchingDelta.modelCalls)}), planner iterations ${summary.a.plannerIterations} -> ${summary.b.plannerIterations} (${fmtDelta(summary.estimatedBatchingDelta.plannerIterations)}), stages ${loadedA.trajectory.stages.length} -> ${loadedB.trajectory.stages.length} (${fmtDelta(summary.estimatedBatchingDelta.stages)})`,
  );
  console.log(
    `Tools: ${summary.a.toolCallsExecuted} -> ${summary.b.toolCallsExecuted} (${fmtDelta(summary.estimatedBatchingDelta.toolCalls)})`,
  );
}

// ---------------------------------------------------------------------------
// Subcommand: aggregate
// ---------------------------------------------------------------------------

interface AggregateOptions {
  since?: number;
  agent?: string;
}

async function cmdAggregate(opts: AggregateOptions): Promise<void> {
  const files = await listTrajectoryFiles();
  const trajectories: RecordedTrajectory[] = [];
  for (const file of files) {
    try {
      const raw = await fs.readFile(file.filePath, "utf8");
      const t = JSON.parse(raw) as RecordedTrajectory;
      if (!Array.isArray(t.stages) || !t.metrics || !t.trajectoryId) continue;
      if (opts.agent && t.agentId !== opts.agent) continue;
      if (opts.since && (t.startedAt ?? 0) < opts.since) continue;
      trajectories.push(t);
    } catch {
      // skip
    }
  }

  if (trajectories.length === 0) {
    console.log(c.dim("No trajectories matched."));
    return;
  }

  const durations = trajectories
    .map((t) => t.metrics?.totalLatencyMs ?? 0)
    .sort((a, b) => a - b);
  const median =
    durations.length === 0
      ? 0
      : (durations[Math.floor(durations.length / 2)] ?? 0);
  const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
  const totalCost = trajectories.reduce((sum, traj) => {
    const recorded = traj.metrics?.totalCostUsd;
    if (typeof recorded === "number" && recorded > 0) return sum + recorded;
    // Fallback: re-derive from per-stage usage when the recorder did not
    // pre-compute. Lets us compare cost across runs even on older trajectories.
    const derived = traj.stages.reduce((stageSum, stage) => {
      if (stage.model?.usage) {
        return (
          stageSum +
          computeCallCostUsd(stage.model.modelName, stage.model.usage)
        );
      }
      return stageSum;
    }, 0);
    return sum + derived;
  }, 0);

  const cacheRates: number[] = [];
  const failureCounts = new Map<string, number>();
  let evaluatorTotal = 0;
  let evaluatorOk = 0;

  for (const t of trajectories) {
    for (const stage of t.stages) {
      if (stage.model?.usage && stage.model.usage.promptTokens > 0) {
        cacheRates.push(
          (stage.model.usage.cacheReadInputTokens ?? 0) /
            Math.max(1, stage.model.usage.promptTokens),
        );
      }
      if (stage.tool && !stage.tool.success) {
        failureCounts.set(
          stage.tool.name,
          (failureCounts.get(stage.tool.name) ?? 0) + 1,
        );
      }
      if (stage.evaluation) {
        evaluatorTotal++;
        if (stage.evaluation.success) evaluatorOk++;
      }
    }
  }
  const meanCache =
    cacheRates.length === 0
      ? 0
      : (cacheRates.reduce((a, b) => a + b, 0) / cacheRates.length) * 100;

  const topFailures = Array.from(failureCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  console.log(c.bold(`${trajectories.length} trajectories analyzed`));
  console.log(
    `Median duration: ${formatDuration(median)} · p95: ${formatDuration(p95)}`,
  );
  console.log(`Total cost: ${formatUsd(totalCost)}`);
  console.log(`Average cache hit rate: ${meanCache.toFixed(1)}%`);
  if (topFailures.length > 0) {
    console.log(
      `Top failing actions: ${topFailures.map(([name, n]) => `${name} (${n})`).join(", ")}`,
    );
  }
  if (evaluatorTotal > 0) {
    console.log(
      `Evaluator success rate: ${((evaluatorOk / evaluatorTotal) * 100).toFixed(1)}%`,
    );
  }
}

// ---------------------------------------------------------------------------
// Argv parsing (lightweight; no dependency)
// ---------------------------------------------------------------------------

interface ParsedFlags {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? "";
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) {
        flags.set(token.slice(2, eq), token.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(token.slice(2), next);
          i++;
        } else {
          flags.set(token.slice(2), true);
        }
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

function flagString(
  flags: Map<string, string | true>,
  key: string,
): string | undefined {
  const v = flags.get(key);
  return typeof v === "string" ? v : undefined;
}

function flagInt(
  flags: Map<string, string | true>,
  key: string,
): number | undefined {
  const v = flagString(flags, key);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function flagDate(
  flags: Map<string, string | true>,
  key: string,
): number | undefined {
  const v = flagString(flags, key);
  if (v === undefined) return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

function flagStringList(
  flags: Map<string, string | true>,
  key: string,
): string[] | undefined {
  const v = flagString(flags, key);
  if (v === undefined) return undefined;
  const values = v
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`trajectory <command> [args]

Commands:
  list [--agent <id>] [--since <iso>] [--limit 20]
  print <id> [--stage <id-or-kind>] [--full]
  stats <id>
  failures <id>
  diff <id> --stages a,b
  replay <id> [--stage <id-or-kind>]
  export <id> --format markdown|html|json [--out <path>]
  validate <id-or-path> [--expected-stages a,b] [--expected-contexts x,y] [--strict-messages] [--json]
  compare <idA> <idB> [--json]
  aggregate [--since <iso>] [--agent <id>]

Trajectories are read from \${MILADY_TRAJECTORY_DIR} (default ./trajectories/).`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }

  const { positional, flags } = parseArgs(argv.slice(1));

  switch (cmd) {
    case "list": {
      await cmdList({
        agent: flagString(flags, "agent"),
        since: flagDate(flags, "since"),
        limit: flagInt(flags, "limit"),
      });
      return;
    }
    case "print": {
      const id = positional[0];
      if (!id) throw new Error("`print` requires a trajectory id");
      await cmdPrint(id, {
        stageId: flagString(flags, "stage"),
        full: flags.has("full") && flags.get("full") !== "false",
      });
      return;
    }
    case "stats": {
      const id = positional[0];
      if (!id) throw new Error("`stats` requires a trajectory id");
      await cmdStats(id);
      return;
    }
    case "failures": {
      const id = positional[0];
      if (!id) throw new Error("`failures` requires a trajectory id");
      await cmdFailures(id);
      return;
    }
    case "diff": {
      const id = positional[0];
      if (!id) throw new Error("`diff` requires a trajectory id");
      const stages = flagString(flags, "stages");
      if (!stages?.includes(",")) {
        throw new Error("`diff` requires --stages a,b");
      }
      const [a, b] = stages.split(",");
      if (!a || !b) throw new Error("--stages must be `a,b`");
      await cmdDiff(id, { stages: [a, b] });
      return;
    }
    case "replay": {
      const id = positional[0];
      if (!id) throw new Error("`replay` requires a trajectory id");
      await cmdReplay(id, flagString(flags, "stage"));
      return;
    }
    case "export": {
      const id = positional[0];
      if (!id) throw new Error("`export` requires a trajectory id");
      const format = (flagString(flags, "format") ?? "markdown") as
        | "markdown"
        | "html"
        | "json";
      if (!["markdown", "html", "json"].includes(format)) {
        throw new Error(`Unknown format: ${format}`);
      }
      await cmdExport(id, { format, out: flagString(flags, "out") });
      return;
    }
    case "validate": {
      const id = positional[0];
      if (!id) throw new Error("`validate` requires a trajectory id or path");
      await cmdValidate(id, {
        expectedStages: flagStringList(flags, "expected-stages"),
        expectedContexts: flagStringList(flags, "expected-contexts"),
        json: flags.has("json") && flags.get("json") !== "false",
        strictMessages:
          flags.has("strict-messages") &&
          flags.get("strict-messages") !== "false",
      });
      return;
    }
    case "compare": {
      const idA = positional[0];
      const idB = positional[1];
      if (!idA || !idB)
        throw new Error("`compare` requires two trajectory ids or paths");
      await cmdCompare(
        idA,
        idB,
        flags.has("json") && flags.get("json") !== "false",
      );
      return;
    }
    case "aggregate": {
      await cmdAggregate({
        since: flagDate(flags, "since"),
        agent: flagString(flags, "agent"),
      });
      return;
    }
    default: {
      console.error(c.red(`Unknown command: ${cmd}`));
      printHelp();
      process.exitCode = 1;
    }
  }
}

main().catch((err) => {
  console.error(c.red(`error: ${(err as Error).message}`));
  process.exitCode = 1;
});
