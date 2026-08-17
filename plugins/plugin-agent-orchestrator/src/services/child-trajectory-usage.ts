/**
 * Sanitized usage projection for a child runtime's file trajectory.
 *
 * The full trajectory can contain prompts, responses, and tool arguments. The
 * orchestrator only needs correlation plus measured model-call totals, so this
 * module validates the recorder's stage sums against its top-level metrics and
 * returns a small persistence-safe summary. The bounded reader at the bottom
 * accepts only stable regular files below the caller's controlled directory;
 * it never follows a task artifact path outside that root.
 */

import { constants, type Stats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RecordedTrajectory } from "@elizaos/core";

export const CHILD_TRAJECTORY_USAGE_METADATA_KEY =
  "childTrajectoryUsageV1" as const;

export interface ChildTrajectoryProviderUsage {
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheTokens: number;
  costUsd: number;
}

export interface ChildTrajectoryUsageSummary {
  version: 1;
  trajectoryId: string;
  traceId?: string;
  taskId: string;
  sessionId: string;
  status: "finished";
  startedAt: number;
  endedAt?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  plannerIterations: number;
  toolCallsExecuted: number;
  toolCallFailures: number;
  /** Successful FILE write/edit paths, normalized relative to the session
   * workdir. This is executor evidence only; prompts/tool content are omitted. */
  changedFiles: string[];
  providerUsage: ChildTrajectoryProviderUsage[];
}

export interface ChildTrajectoryUsageExpectation {
  trajectoryId: string;
  taskId: string;
  sessionId: string;
  fallbackProvider: string;
  fallbackModel?: string;
  workdir?: string;
}

export type ChildTrajectoryReadFailureReason = "untrusted_path" | "read_failed";

export class ChildTrajectoryReadError extends Error {
  readonly reason: ChildTrajectoryReadFailureReason;

  constructor(reason: ChildTrajectoryReadFailureReason, message: string) {
    super(message);
    this.name = "ChildTrajectoryReadError";
    this.reason = reason;
  }
}

const MAX_CHILD_TRAJECTORY_BYTES = 32 * 1024 * 1024;
const MAX_CHILD_TRAJECTORY_STAGES = 4_096;
const MAX_CHILD_TRAJECTORY_PROVIDER_BUCKETS = 64;
const MAX_USAGE_LABEL_CHARS = 256;
const MAX_CHANGED_FILE_PATHS = 500;
const MAX_CHANGED_FILE_PATH_CHARS = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_USAGE_LABEL_CHARS
    ? trimmed
    : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function tokenCount(value: unknown): number | undefined {
  const number = finiteNonNegative(value);
  return number !== undefined && Number.isSafeInteger(number)
    ? number
    : undefined;
}

function optionalTokenCount(value: unknown): number | undefined {
  return value === undefined ? 0 : tokenCount(value);
}

function optionalCost(value: unknown): number | undefined {
  return value === undefined ? 0 : finiteNonNegative(value);
}

function costsMatch(left: number, right: number): boolean {
  const tolerance = Math.max(1e-12, Math.abs(left) * 1e-9);
  return Math.abs(left - right) <= tolerance;
}

function sanitizeRelativeChangedPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.length > MAX_CHANGED_FILE_PATH_CHARS ||
    trimmed.includes("\0") ||
    isAbsolute(trimmed)
  ) {
    return undefined;
  }
  const segments = trimmed.split(/[\\/]+/);
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return segments.join("/");
}

function successfulFileMutations(
  stages: readonly unknown[],
  workdir: string | undefined,
): string[] {
  if (!workdir) return [];
  const root = resolve(workdir);
  const changed = new Set<string>();
  for (const stage of stages) {
    if (changed.size >= MAX_CHANGED_FILE_PATHS) break;
    if (!isRecord(stage)) continue;
    const tool = isRecord(stage.tool) ? stage.tool : undefined;
    if (tool?.name !== "FILE" || tool.success !== true) continue;
    const args = isRecord(tool.args) ? tool.args : undefined;
    if (!args || (args.action !== "write" && args.action !== "edit")) continue;
    if (args.target !== undefined && args.target !== "workspace") continue;
    if (typeof args.file_path !== "string" || args.file_path.includes("\0")) {
      continue;
    }
    const absolute = isAbsolute(args.file_path)
      ? resolve(args.file_path)
      : resolve(root, args.file_path);
    const rel = relative(root, absolute);
    const normalized = sanitizeRelativeChangedPath(rel);
    if (normalized) changed.add(normalized);
  }
  return [...changed];
}

function persistedChangedFiles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const changed = new Set<string>();
  for (const path of value.slice(0, MAX_CHANGED_FILE_PATHS)) {
    const normalized = sanitizeRelativeChangedPath(path);
    if (normalized) changed.add(normalized);
  }
  return [...changed];
}

/**
 * Validate and project a recorder trajectory. Returns `null` when correlation,
 * completion state, numeric integrity, or stage/top-level agreement fails.
 */
export function summarizeChildTrajectoryUsage(
  value: unknown,
  expected: ChildTrajectoryUsageExpectation,
): ChildTrajectoryUsageSummary | null {
  if (!isRecord(value)) return null;
  if (nonEmptyString(value.trajectoryId) !== expected.trajectoryId) return null;
  if (nonEmptyString(value.taskId) !== expected.taskId) return null;
  if (nonEmptyString(value.sessionId) !== expected.sessionId) return null;
  if (value.status !== "finished") return null;

  const startedAt = finiteNonNegative(value.startedAt);
  const endedAt = optionalCost(value.endedAt);
  const metrics = isRecord(value.metrics) ? value.metrics : undefined;
  const stages = Array.isArray(value.stages) ? value.stages : undefined;
  if (
    startedAt === undefined ||
    endedAt === undefined ||
    !metrics ||
    !stages ||
    stages.length > MAX_CHILD_TRAJECTORY_STAGES
  ) {
    return null;
  }

  const inputTokens = tokenCount(metrics.totalPromptTokens);
  const outputTokens = tokenCount(metrics.totalCompletionTokens);
  const reasoningTokens = optionalTokenCount(metrics.totalReasoningTokens);
  const cacheReadTokens = tokenCount(metrics.totalCacheReadTokens);
  const cacheCreationTokens = tokenCount(metrics.totalCacheCreationTokens);
  const costUsd = finiteNonNegative(metrics.totalCostUsd);
  const plannerIterations = tokenCount(metrics.plannerIterations);
  const toolCallsExecuted = tokenCount(metrics.toolCallsExecuted);
  const toolCallFailures = tokenCount(metrics.toolCallFailures);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    reasoningTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheCreationTokens === undefined ||
    costUsd === undefined ||
    plannerIterations === undefined ||
    toolCallsExecuted === undefined ||
    toolCallFailures === undefined
  ) {
    return null;
  }

  const buckets = new Map<string, ChildTrajectoryProviderUsage>();
  for (const stage of stages) {
    if (!isRecord(stage) || !isRecord(stage.model)) continue;
    const modelCall = stage.model;
    const usage = isRecord(modelCall.usage) ? modelCall.usage : undefined;
    const stageCost = optionalCost(modelCall.costUsd);
    if (!usage && stageCost === 0) continue;
    if (stageCost === undefined) return null;

    const stageInput = optionalTokenCount(usage?.promptTokens);
    const stageOutput = optionalTokenCount(usage?.completionTokens);
    const stageReasoning = optionalTokenCount(usage?.reasoningTokens);
    const stageCacheRead = optionalTokenCount(usage?.cacheReadInputTokens);
    const stageCacheCreation = optionalTokenCount(
      usage?.cacheCreationInputTokens,
    );
    if (
      stageInput === undefined ||
      stageOutput === undefined ||
      stageReasoning === undefined ||
      stageCacheRead === undefined ||
      stageCacheCreation === undefined
    ) {
      return null;
    }

    const provider =
      nonEmptyString(modelCall.provider) ?? expected.fallbackProvider;
    const model = nonEmptyString(modelCall.modelName) ?? expected.fallbackModel;
    const key = `${provider}\u0000${model ?? ""}`;
    if (
      !buckets.has(key) &&
      buckets.size >= MAX_CHILD_TRAJECTORY_PROVIDER_BUCKETS
    ) {
      return null;
    }
    const bucket = buckets.get(key) ?? {
      provider,
      ...(model ? { model } : {}),
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
    };
    bucket.inputTokens += stageInput;
    bucket.outputTokens += stageOutput;
    bucket.reasoningTokens += stageReasoning;
    bucket.cacheTokens += stageCacheRead + stageCacheCreation;
    bucket.costUsd += stageCost;
    if (
      !Number.isSafeInteger(bucket.inputTokens) ||
      !Number.isSafeInteger(bucket.outputTokens) ||
      !Number.isSafeInteger(bucket.reasoningTokens) ||
      !Number.isSafeInteger(bucket.cacheTokens) ||
      !Number.isFinite(bucket.costUsd)
    ) {
      return null;
    }
    buckets.set(key, bucket);
  }

  const providerUsage = [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, usage]) => usage);
  const stageTotals = providerUsage.reduce(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      reasoningTokens: total.reasoningTokens + usage.reasoningTokens,
      cacheTokens: total.cacheTokens + usage.cacheTokens,
      costUsd: total.costUsd + usage.costUsd,
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      costUsd: 0,
    },
  );
  if (
    stageTotals.inputTokens !== inputTokens ||
    stageTotals.outputTokens !== outputTokens ||
    stageTotals.reasoningTokens !== reasoningTokens ||
    stageTotals.cacheTokens !== cacheReadTokens + cacheCreationTokens ||
    !costsMatch(stageTotals.costUsd, costUsd)
  ) {
    return null;
  }

  return {
    version: 1,
    trajectoryId: expected.trajectoryId,
    ...(nonEmptyString(value.traceId)
      ? { traceId: nonEmptyString(value.traceId) }
      : {}),
    taskId: expected.taskId,
    sessionId: expected.sessionId,
    status: "finished",
    startedAt,
    ...(value.endedAt !== undefined ? { endedAt } : {}),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheCreationTokens,
    costUsd,
    plannerIterations,
    toolCallsExecuted,
    toolCallFailures,
    changedFiles: successfulFileMutations(stages, expected.workdir),
    providerUsage,
  };
}

/** Validate a summary read back from persisted artifact metadata. */
export function parseChildTrajectoryUsageSummary(
  value: unknown,
): ChildTrajectoryUsageSummary | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const trajectoryId = nonEmptyString(value.trajectoryId);
  const taskId = nonEmptyString(value.taskId);
  const sessionId = nonEmptyString(value.sessionId);
  const fallbackProvider = "unknown";
  if (!trajectoryId || !taskId || !sessionId) return null;

  const providerUsage = Array.isArray(value.providerUsage)
    ? value.providerUsage
    : undefined;
  if (
    !providerUsage ||
    providerUsage.length > MAX_CHILD_TRAJECTORY_PROVIDER_BUCKETS
  ) {
    return null;
  }
  const stages = providerUsage.map((entry, index) => {
    if (!isRecord(entry)) return null;
    return {
      stageId: `persisted-${index}`,
      kind: "planner",
      startedAt: 0,
      endedAt: 0,
      latencyMs: 0,
      model: {
        modelType: "persisted",
        provider: entry.provider,
        modelName: entry.model,
        response: "",
        usage: {
          promptTokens: entry.inputTokens,
          completionTokens: entry.outputTokens,
          reasoningTokens: entry.reasoningTokens,
          cacheReadInputTokens: entry.cacheTokens,
          cacheCreationInputTokens: 0,
        },
        costUsd: entry.costUsd,
      },
    };
  });
  if (stages.some((stage) => stage === null)) return null;

  const summary = summarizeChildTrajectoryUsage(
    {
      trajectoryId,
      taskId,
      sessionId,
      traceId: value.traceId,
      status: value.status,
      startedAt: value.startedAt,
      endedAt: value.endedAt,
      stages,
      metrics: {
        totalPromptTokens: value.inputTokens,
        totalCompletionTokens: value.outputTokens,
        totalReasoningTokens: value.reasoningTokens,
        totalCacheReadTokens: value.cacheReadTokens,
        totalCacheCreationTokens: value.cacheCreationTokens,
        totalCostUsd: value.costUsd,
        plannerIterations: value.plannerIterations,
        toolCallsExecuted: value.toolCallsExecuted,
        toolCallFailures: value.toolCallFailures,
      },
    },
    { trajectoryId, taskId, sessionId, fallbackProvider },
  );
  return summary
    ? {
        ...summary,
        changedFiles: persistedChangedFiles(value.changedFiles),
      }
    : null;
}

/** Convert the sanitized projection into the metrics-only shape the core
 * trace roll-up consumes. No prompt, response, or tool content is restored. */
export function childTrajectoryUsageAsRecordedTrajectory(
  summary: ChildTrajectoryUsageSummary,
): RecordedTrajectory {
  return {
    trajectoryId: summary.trajectoryId,
    agentId: "usage-summary",
    ...(summary.traceId ? { traceId: summary.traceId } : {}),
    taskId: summary.taskId,
    sessionId: summary.sessionId,
    rootMessage: { id: "usage-summary", text: "" },
    startedAt: summary.startedAt,
    ...(summary.endedAt !== undefined ? { endedAt: summary.endedAt } : {}),
    status: summary.status,
    stages: [],
    metrics: {
      totalLatencyMs: 0,
      totalPromptTokens: summary.inputTokens,
      totalCompletionTokens: summary.outputTokens,
      totalCacheReadTokens: summary.cacheReadTokens,
      totalCacheCreationTokens: summary.cacheCreationTokens,
      totalReasoningTokens: summary.reasoningTokens,
      totalCostUsd: summary.costUsd,
      plannerIterations: summary.plannerIterations,
      toolCallsExecuted: summary.toolCallsExecuted,
      toolCallFailures: summary.toolCallFailures,
      toolSearchCount: 0,
      evaluatorFailures: 0,
    },
  };
}

/** Lexical first-pass containment check. This runs before any filesystem call,
 * so an attacker-controlled external artifact path is never even opened. */
export function isControlledChildTrajectoryPath(
  root: string,
  candidate: string,
): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  return (
    rel.length > 0 &&
    rel !== ".." &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    right.isFile()
  );
}

/**
 * Read one child trajectory without path escape, symlink following, unbounded
 * allocation, or a swap/append race. JSON/schema validation remains the
 * caller's responsibility because the trace and task-usage consumers accept
 * different legacy shapes.
 */
export async function readControlledChildTrajectoryJson(
  root: string,
  candidate: string,
): Promise<unknown> {
  if (!isControlledChildTrajectoryPath(root, candidate)) {
    throw new ChildTrajectoryReadError(
      "untrusted_path",
      "Trajectory artifact path is outside the controlled child directory.",
    );
  }

  try {
    const initial = await lstat(candidate);
    if (!initial.isFile() || initial.isSymbolicLink()) {
      throw new ChildTrajectoryReadError(
        "untrusted_path",
        "Trajectory artifact is not a regular file.",
      );
    }
    if (initial.size > MAX_CHILD_TRAJECTORY_BYTES) {
      throw new ChildTrajectoryReadError(
        "read_failed",
        "Trajectory artifact exceeds the 32 MiB read limit.",
      );
    }

    const [rootReal, candidateReal] = await Promise.all([
      realpath(root),
      realpath(candidate),
    ]);
    if (!isControlledChildTrajectoryPath(rootReal, candidateReal)) {
      throw new ChildTrajectoryReadError(
        "untrusted_path",
        "Trajectory artifact resolves outside the controlled child directory.",
      );
    }

    const handle = await open(
      candidate,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const opened = await handle.stat();
      if (!sameFile(initial, opened)) {
        throw new ChildTrajectoryReadError(
          "read_failed",
          "Trajectory artifact changed before it could be opened safely.",
        );
      }
      const bytes = Buffer.allocUnsafe(initial.size + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat();
      if (offset !== initial.size || !sameFile(initial, after)) {
        throw new ChildTrajectoryReadError(
          "read_failed",
          "Trajectory artifact changed while it was being read.",
        );
      }
      try {
        return JSON.parse(
          bytes.subarray(0, offset).toString("utf8"),
        ) as unknown;
      } catch {
        throw new ChildTrajectoryReadError(
          "read_failed",
          "Trajectory artifact is not valid JSON.",
        );
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ChildTrajectoryReadError) throw error;
    throw new ChildTrajectoryReadError(
      "read_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}
