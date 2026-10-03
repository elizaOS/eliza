/** Optional JSON-file trajectory persistence and cost annotation. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  cloneTrajectoryValue,
  composeToolDiagnosticRedactor,
  ElizaError,
  isTrajectoryRecordingEnabled,
  type ListTrajectoriesOptions,
  projectRecordedStageToolDiagnostics,
  type RecordedModelCall,
  type RecordedStage,
  type RecordedTrajectory,
  type RecordedTrajectoryMetrics,
  type RecorderLogger,
  readEnv,
  resolveAliasedEnvValue,
  resolveStateDir,
  resolveTraceCorrelationFromEnv,
  type StartTrajectoryInput,
  stringifyForDiagnostics,
  type ToolDiagnosticTextRedactor,
  type TraceCorrelation,
  type TrajectoryRecorder,
  toWellFormedUnicode,
} from "@elizaos/core";
import { computeCallCostUsd, PRICE_TABLE_ID } from "./model-pricing";

function envFlagEnabled(key: string, defaultValue = false): boolean {
  const raw = process.env[key];
  if (raw === undefined) return defaultValue;
  const normalized = raw.trim().toLowerCase();
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "no" ||
    normalized === "off"
  ) {
    return false;
  }
  return normalized.length > 0;
}

/**
 * Resolve the on-disk trajectory directory. Precedence per PLAN.md §18.1:
 *   ELIZA_TRAJECTORY_DIR
 *   ELIZA_STATE_DIR/trajectories
 *   XDG state-dir/trajectories
 */
export function resolveTrajectoryDir(): string {
  const explicit = process.env.ELIZA_TRAJECTORY_DIR?.trim();
  if (explicit) return explicit;

  const elizaState = resolveAliasedEnvValue("ELIZA_STATE_DIR")?.trim();
  if (elizaState) return path.join(elizaState, "trajectories");

  return path.join(resolveStateDir(), "trajectories");
}

/**
 * Review mode writes a human-readable markdown sibling for every JSON
 * trajectory. It is opt-in so default runtime writes stay unchanged.
 */
export function isTrajectoryMarkdownReviewEnabled(): boolean {
  return (
    envFlagEnabled("ELIZA_TRAJECTORY_REVIEW_MODE") ||
    envFlagEnabled("ELIZA_TRAJECTORY_MARKDOWN") ||
    Boolean(process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR?.trim())
  );
}

function resolveTrajectoryMarkdownDir(rootDir: string): string {
  return process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR?.trim() || rootDir;
}

function safeRandomId(prefix: string): string {
  // Avoid pulling in node:crypto for hot-path id generation; the recorder
  // id space is small per agent.
  const rand = Math.random().toString(16).slice(2, 10);
  const ts = Date.now().toString(16).slice(-6);
  return `${prefix}-${ts}${rand}`;
}

function trajectoryFileName(id: string): string {
  return `${id}.json`;
}

function atomicTempPath(filePath: string): string {
  const rand = Math.random().toString(16).slice(2);
  return `${filePath}.${process.pid}.${Date.now().toString(36)}.${rand}.tmp`;
}

async function atomicWriteFile(
  filePath: string,
  value: string,
  logger?: RecorderLogger,
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = atomicTempPath(filePath);
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(tmp, value, "utf8");
    await fs.rename(tmp, filePath);
  } catch (error) {
    logger?.warn?.(
      { err: (error as Error).message, filePath },
      "[TrajectoryRecorder] atomic write failed",
    );
    try {
      await fs.unlink(tmp);
    } catch (cleanupError) {
      // error-policy:J6 best-effort teardown retains the original write failure
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") {
        logger?.warn?.(
          { err: (cleanupError as Error).message, tmp },
          "[TrajectoryRecorder] temporary file cleanup failed",
        );
      }
    }
    throw new ElizaError("Failed to persist trajectory artifact", {
      code: "TRAJECTORY_ATOMIC_WRITE_FAILED",
      cause: error,
      context: { filePath },
    });
  }
}

async function atomicWriteJson(
  filePath: string,
  value: unknown,
  logger?: RecorderLogger,
): Promise<void> {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new ElizaError("Trajectory artifact is not JSON-serializable", {
      code: "TRAJECTORY_ARTIFACT_INVALID",
      context: { filePath },
    });
  }
  await atomicWriteFile(filePath, serialized, logger);
}

function formatTimestamp(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "-";
  return new Date(ms).toISOString();
}

function formatDuration(ms: number | undefined): string {
  if (!ms || !Number.isFinite(ms)) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function safeStringifyForMarkdown(value: unknown): string {
  return stringifyForDiagnostics(value);
}

function redactMarkdownSecrets(text: string): string {
  if (!envFlagEnabled("ELIZA_TRAJECTORY_MARKDOWN_REDACT", true)) {
    return text;
  }
  const explicitSecrets = [
    process.env.CEREBRAS_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.ANTHROPIC_API_KEY,
    process.env.GROQ_API_KEY,
  ].filter((value): value is string => Boolean(value?.trim()));
  let out = text;
  for (const secret of explicitSecrets) {
    out = out.split(secret).join("[REDACTED_SECRET]");
  }
  return out
    .replace(/\bcsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_CEREBRAS_KEY]")
    .replace(/\bsk-(?!test-)[A-Za-z0-9_-]{8,}\b/g, "[REDACTED_OPENAI_KEY]")
    .replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/g,
      "Bearer [REDACTED_TOKEN]",
    );
}

function markdownFence(value: string, language = ""): string[] {
  const fence = value.includes("```") ? "````" : "```";
  return [language ? `${fence}${language}` : fence, value, fence];
}

function summarizeEmbeddingResponse(response: string): string | null {
  const trimmed = response.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((value) => typeof value === "number")
    ) {
      return null;
    }
    const preview = parsed
      .slice(0, 8)
      .map((value) => Number(value).toFixed(4))
      .join(", ");
    return `Embedding vector (${parsed.length} dimensions). Preview: [${preview}${parsed.length > 8 ? ", ..." : ""}]`;
  } catch {
    // error-policy:J7 malformed embedding previews must not break trajectory rendering
    return null;
  }
}

function modelResponseForMarkdown(model: RecordedModelCall): string {
  if (model.modelType === "TEXT_EMBEDDING") {
    const summary = summarizeEmbeddingResponse(model.response);
    if (summary) return summary;
  }
  return model.response;
}

function renderTrajectoryMarkdown(trajectory: RecordedTrajectory): string {
  const lines: string[] = [];
  const metrics = trajectory.metrics;
  lines.push(`# Trajectory ${trajectory.trajectoryId}`);
  lines.push("");
  lines.push(`- agent: \`${trajectory.agentId}\``);
  lines.push(`- room: \`${trajectory.roomId ?? "-"}\``);
  lines.push(`- status: ${trajectory.status}`);
  lines.push(`- started: ${formatTimestamp(trajectory.startedAt)}`);
  lines.push(`- ended: ${formatTimestamp(trajectory.endedAt)}`);
  lines.push(
    `- total: ${formatDuration(metrics.totalLatencyMs)} · $${metrics.totalCostUsd.toFixed(6)}`,
  );
  lines.push(
    `- tokens: ${metrics.totalPromptTokens} input · ${metrics.totalCompletionTokens} output · ${metrics.totalCacheReadTokens} cache-read · ${metrics.totalCacheCreationTokens} cache-created · ${metrics.totalReasoningTokens} reasoning`,
  );
  lines.push(`- root message id: \`${trajectory.rootMessage.id}\``);
  if (trajectory.rootMessage.text) {
    lines.push("");
    lines.push("## Root Message");
    lines.push("");
    lines.push(...markdownFence(trajectory.rootMessage.text));
  }
  lines.push("");

  for (const [index, stage] of trajectory.stages.entries()) {
    lines.push(
      `## Stage ${index + 1}: ${stage.kind}${stage.iteration ? ` iter ${stage.iteration}` : ""} (${stage.stageId})`,
    );
    lines.push("");
    lines.push(`- latency: ${formatDuration(stage.latencyMs)}`);
    lines.push(`- started: ${formatTimestamp(stage.startedAt)}`);
    lines.push(`- ended: ${formatTimestamp(stage.endedAt)}`);
    if (stage.parentStageId) {
      lines.push(`- parent: \`${stage.parentStageId}\``);
    }
    if (stage.model) {
      const providerLabel = stage.model.provider
        ? ` (${stage.model.provider})`
        : "";
      lines.push(
        `- model: \`${stage.model.modelName ?? stage.model.modelType}\`${providerLabel}`,
      );
      if (stage.model.usage) {
        lines.push(
          `- usage: ${stage.model.usage.promptTokens ?? "n/a"} input · ${stage.model.usage.completionTokens ?? "n/a"} output · ${stage.model.usage.cacheReadInputTokens ?? "n/a"} cache-read · ${stage.model.usage.cacheCreationInputTokens ?? "n/a"} cache-created · ${stage.model.usage.reasoningTokens ?? "n/a"} reasoning`,
        );
      }
      if (typeof stage.model.costUsd === "number") {
        lines.push(`- cost: $${stage.model.costUsd.toFixed(6)}`);
      }
      if (typeof stage.model.prompt === "string") {
        const prompt = stage.model.prompt;
        lines.push("");
        lines.push("### Prompt");
        lines.push("");
        lines.push(...markdownFence(prompt));
      }
      lines.push("");
      lines.push("### Response");
      lines.push("");
      lines.push(...markdownFence(modelResponseForMarkdown(stage.model)));
      if (stage.model.messages !== undefined) {
        lines.push("");
        lines.push("### Messages");
        lines.push("");
        lines.push(
          ...markdownFence(
            safeStringifyForMarkdown(stage.model.messages),
            "json",
          ),
        );
      }
      if (stage.model.tools !== undefined) {
        lines.push("");
        lines.push("### Tools");
        lines.push("");
        lines.push(
          ...markdownFence(safeStringifyForMarkdown(stage.model.tools), "json"),
        );
      }
      if (stage.model.toolCalls !== undefined) {
        lines.push("");
        lines.push("### Tool Calls");
        lines.push("");
        lines.push(
          ...markdownFence(
            safeStringifyForMarkdown(stage.model.toolCalls),
            "json",
          ),
        );
      }
      if (stage.model.providerOptions !== undefined) {
        lines.push("");
        lines.push("### Provider Options");
        lines.push("");
        lines.push(
          ...markdownFence(
            safeStringifyForMarkdown(stage.model.providerOptions),
            "json",
          ),
        );
      }
    }
    if (stage.tool) {
      lines.push("");
      lines.push("### Tool Result");
      lines.push("");
      lines.push(
        `- tool: \`${stage.tool.name}\` ${stage.tool.success ? "ok" : "failed"}`,
      );
      if (stage.tool.description) {
        lines.push(`- description: ${stage.tool.description}`);
      }
      lines.push(`- duration: ${formatDuration(stage.tool.durationMs)}`);
      lines.push(
        ...markdownFence(
          safeStringifyForMarkdown({
            args: stage.tool.args,
            result: stage.tool.result,
          }),
          "json",
        ),
      );
    }
    if (stage.evaluation) {
      lines.push("");
      lines.push("### Evaluation");
      lines.push("");
      lines.push(
        ...markdownFence(safeStringifyForMarkdown(stage.evaluation), "json"),
      );
    }
    if (stage.cache) {
      lines.push("");
      lines.push("### Cache");
      lines.push("");
      lines.push(
        ...markdownFence(safeStringifyForMarkdown(stage.cache), "json"),
      );
    }
    lines.push("");
  }

  return `${redactMarkdownSecrets(lines.join("\n")).trimEnd()}\n`;
}

function applyMetricsForStage(
  metrics: RecordedTrajectoryMetrics,
  stage: RecordedStage,
): void {
  metrics.totalLatencyMs += Number.isFinite(stage.latencyMs)
    ? stage.latencyMs
    : 0;

  if (stage.model?.usage) {
    if (stage.model.usage.promptTokens !== undefined) {
      metrics.totalPromptTokens += stage.model.usage.promptTokens;
    }
    if (stage.model.usage.completionTokens !== undefined) {
      metrics.totalCompletionTokens += stage.model.usage.completionTokens;
    }
    metrics.totalCacheReadTokens += stage.model.usage.cacheReadInputTokens ?? 0;
    metrics.totalCacheCreationTokens +=
      stage.model.usage.cacheCreationInputTokens ?? 0;
    metrics.totalReasoningTokens =
      (metrics.totalReasoningTokens ?? 0) +
      (stage.model.usage.reasoningTokens ?? 0);
  }
  if (typeof stage.model?.costUsd === "number") {
    metrics.totalCostUsd += stage.model.costUsd;
  }

  if (stage.kind === "planner") metrics.plannerIterations += 1;
  if (stage.kind === "tool") {
    metrics.toolCallsExecuted += 1;
    if (stage.tool && !stage.tool.success) metrics.toolCallFailures += 1;
  }
  if (stage.kind === "toolSearch") metrics.toolSearchCount += 1;
  if (
    stage.kind === "evaluation" &&
    ((typeof stage.evaluation?.parseError === "string" &&
      stage.evaluation.parseError.trim().length > 0) ||
      stage.evaluation?.protocolFailure === true)
  ) {
    metrics.evaluatorFailures += 1;
  }

  const decision = stage.evaluation?.decision;
  if (decision === "FINISH") {
    metrics.finalDecision = "FINISH";
  } else if (decision) {
    // Track that we're still going. `endTrajectory` will overwrite on error.
    metrics.finalDecision = "CONTINUE";
  }
}

function cloneRootMessageForRecord(
  rootMessage: StartTrajectoryInput["rootMessage"],
): RecordedTrajectory["rootMessage"] {
  return {
    id: String(rootMessage.id),
    text: toWellFormedUnicode(String(rootMessage.text)),
    sender:
      rootMessage.sender === undefined
        ? undefined
        : toWellFormedUnicode(String(rootMessage.sender)),
  };
}

/**
 * Annotate a stage with `costUsd` and `priceTableId` if the model has
 * known pricing and the stage didn't already set it. The `model.modelName`
 * is the lookup key; `model.provider` is used to suppress the
 * missing-model warning for local-tier inference (Ollama, LM Studio,
 * llama.cpp).
 *
 * Recorder hooks call `computeCallCostUsd` themselves when they have the
 * data; this function is the fallback for callers that hand off raw
 * stages. Passing a logger lets the canonical pricing module emit a
 * structured warning when a hosted-provider model has no price entry.
 */
export function annotateStageCost(
  stage: RecordedStage,
  logger?: RecorderLogger,
): void {
  if (!stage.model) return;
  if (typeof stage.model.costUsd === "number") {
    // Caller already attached a cost — only tag the table id so consumers
    // know which snapshot it was computed against.
    if (!stage.model.priceTableId) {
      stage.model.priceTableId = PRICE_TABLE_ID;
    }
    return;
  }
  const cost = computeCallCostUsd(stage.model.modelName, stage.model.usage, {
    provider: stage.model.provider,
    logger,
  });
  if (cost !== undefined) {
    stage.model.costUsd = cost;
    stage.model.priceTableId = PRICE_TABLE_ID;
  }
}

// ---------------------------------------------------------------------------
// JsonFileTrajectoryRecorder
// ---------------------------------------------------------------------------

export interface CreateJsonFileRecorderOptions {
  rootDir?: string;
  logger?: RecorderLogger;
  enabled?: boolean;
  reportError?: (
    scope: string,
    error: unknown,
    context?: Record<string, unknown>,
  ) => void;
  /**
   * Runtime-known-secret redaction (e.g. `runtime.redactSecrets`) composed
   * into the recorder's final-persistence diagnostic projection (see
   * {@link projectRecordedStageToolDiagnostics}). The shared tool-shape
   * pattern pass always runs regardless — the option only ADDS
   * character-configured secret masking, so a recorder constructed without a
   * runtime still never persists raw credential-shaped argument values.
   */
  redactSecrets?: (text: string) => string;
}

interface MutableTrajectory extends RecordedTrajectory {}

class JsonFileTrajectoryRecorder implements TrajectoryRecorder {
  private readonly rootDir: string;
  private readonly markdownDir: string;
  private readonly logger?: RecorderLogger;
  private readonly reportError?: CreateJsonFileRecorderOptions["reportError"];
  private readonly enabled: boolean;
  private readonly markdownEnabled: boolean;
  private readonly redactText: ToolDiagnosticTextRedactor;
  private readonly active = new Map<string, MutableTrajectory>();
  private readonly flushQueues = new Map<string, Promise<void>>();

  constructor(opts: CreateJsonFileRecorderOptions = {}) {
    this.rootDir = opts.rootDir ?? resolveTrajectoryDir();
    this.markdownDir = resolveTrajectoryMarkdownDir(this.rootDir);
    this.logger = opts.logger;
    this.reportError = opts.reportError;
    this.redactText = composeToolDiagnosticRedactor({
      redactSecrets: opts.redactSecrets,
    });
    this.enabled =
      opts.enabled !== undefined
        ? opts.enabled
        : isTrajectoryRecordingEnabled();
    this.markdownEnabled = this.enabled && isTrajectoryMarkdownReviewEnabled();
  }

  startTrajectory(input: StartTrajectoryInput): string {
    const id = safeRandomId("tj");
    if (!this.enabled) {
      return id;
    }

    // Correlation resolution mirrors the existing runId/scenarioId env
    // fallback: explicit input wins, else the env the spawner set, else — for
    // traceId specifically — mint one so every trajectory is joinable even
    // when no parent stamped a trace.
    const inheritedCorrelation = resolveTraceCorrelationFromEnv();
    const correlation: TraceCorrelation = {
      traceId:
        input.traceId ?? inheritedCorrelation.traceId ?? crypto.randomUUID(),
      taskId: input.taskId ?? inheritedCorrelation.taskId,
      sessionId: input.sessionId ?? inheritedCorrelation.sessionId,
      parentStepId: input.parentStepId ?? inheritedCorrelation.parentStepId,
    };

    const trajectory: MutableTrajectory = {
      trajectoryId: id,
      agentId: input.agentId,
      roomId: input.roomId,
      // The scenario CLI stamps these before each run/scenario (cli.ts); an
      // explicit call-site value wins. readEnv treats blank/whitespace as
      // unset so a cleared env var never writes an empty correlation key.
      runId: input.runId ?? readEnv("ELIZA_LIFEOPS_RUN_ID"),
      scenarioId: input.scenarioId ?? readEnv("ELIZA_LIFEOPS_SCENARIO_ID"),
      traceId: correlation.traceId,
      taskId: correlation.taskId,
      sessionId: correlation.sessionId,
      parentStepId: correlation.parentStepId,
      codingActionProfile: input.codingActionProfile,
      rootMessage: cloneRootMessageForRecord(input.rootMessage),
      startedAt: Date.now(),
      status: "running",
      stages: [],
      metrics: {
        totalLatencyMs: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheCreationTokens: 0,
        totalReasoningTokens: 0,
        totalCostUsd: 0,
        plannerIterations: 0,
        toolCallsExecuted: 0,
        toolCallFailures: 0,
        toolSearchCount: 0,
        evaluatorFailures: 0,
      },
    };
    this.active.set(id, trajectory);

    // The initial flush is diagnostic and detached from message delivery.
    void this.queueFlushTrajectory(trajectory).catch((err) => {
      // error-policy:J7 Report a missing initial trajectory artifact without
      // aborting the message path that started it.
      this.reportError?.("TrajectoryRecorder.initialFlush", err, {
        trajectoryId: id,
      });
      this.logger?.warn?.(
        { err: (err as Error).message, trajectoryId: id },
        "[TrajectoryRecorder] initial flush failed",
      );
    });
    return id;
  }

  async recordStage(trajectoryId: string, stage: RecordedStage): Promise<void> {
    if (!this.enabled) return;
    const trajectory = this.active.get(trajectoryId);
    if (!trajectory) {
      this.logger?.warn?.(
        { trajectoryId },
        "[TrajectoryRecorder] recordStage: trajectory not found (was startTrajectory called?)",
      );
      return;
    }

    const recordedStage = cloneTrajectoryValue(stage);
    projectRecordedStageToolDiagnostics(recordedStage, this.redactText);
    annotateStageCost(recordedStage, this.logger);
    trajectory.stages.push(recordedStage);
    applyMetricsForStage(trajectory.metrics, recordedStage);

    await this.queueFlushTrajectory(trajectory);
  }

  async endTrajectory(
    trajectoryId: string,
    status: "finished" | "errored",
  ): Promise<void> {
    if (!this.enabled) return;
    const trajectory = this.active.get(trajectoryId);
    if (!trajectory) {
      this.logger?.warn?.(
        { trajectoryId },
        "[TrajectoryRecorder] endTrajectory: trajectory not found",
      );
      return;
    }

    trajectory.status = status;
    trajectory.endedAt = Date.now();
    if (status === "errored" && !trajectory.metrics.finalDecision) {
      trajectory.metrics.finalDecision = "error";
    }
    // Non-evaluated terminal paths (Stage-1 direct reply, deterministic
    // fallback, structured failure reply) finish a turn without any
    // evaluation stage, so nothing above ever set finalDecision. Stamp the
    // clean terminal here — an absent finalDecision on a finished
    // trajectory reads as "died mid-turn" and made delivered turns look
    // like drops. The value must be a member of the canonical validator's
    // closed vocabulary (packages/scripts/lib/trajectory-validate.ts) —
    // every recorded trajectory round-trips through it, and an invented
    // sentinel is rejected as an invalid finalDecision. "FINISH" is the
    // accepted shape for a cleanly finished run; whether an evaluator
    // produced it remains distinguishable from the trajectory itself (an
    // evaluator-decided FINISH always has an evaluation stage).
    if (status === "finished" && !trajectory.metrics.finalDecision) {
      trajectory.metrics.finalDecision = "FINISH";
    }

    try {
      await this.queueFlushTrajectory(trajectory);
    } finally {
      // Always retire the trajectory, even when the terminal flush fails —
      // otherwise a failed write leaves the entry in `active` forever and
      // late recordStage calls keep resurrecting a half-dead record.
      this.active.delete(trajectoryId);
      this.flushQueues.delete(trajectoryId);
    }
  }

  async load(trajectoryId: string): Promise<RecordedTrajectory | null> {
    const inMem = this.active.get(trajectoryId);
    if (inMem) return inMem;

    const files = await this.collectAllFiles();
    const match = files.find((f) => f.id === trajectoryId);
    if (!match) return null;
    try {
      const raw = await fs.readFile(match.filePath, "utf8");
      return JSON.parse(raw) as RecordedTrajectory;
    } catch (error) {
      // error-policy:J2 preserve the storage failure while identifying the trajectory
      throw new ElizaError("Failed to load recorded trajectory", {
        code: "TRAJECTORY_LOAD_FAILED",
        cause: error,
        context: { trajectoryId, filePath: match.filePath },
      });
    }
  }

  async list(
    opts: ListTrajectoriesOptions = {},
  ): Promise<RecordedTrajectory[]> {
    const files = await this.collectAllFiles();
    const out: RecordedTrajectory[] = [];
    for (const file of files) {
      try {
        const raw = await fs.readFile(file.filePath, "utf8");
        const trajectory = JSON.parse(raw) as RecordedTrajectory;
        if (opts.agentId && trajectory.agentId !== opts.agentId) continue;
        if (opts.since && trajectory.startedAt < opts.since) continue;
        out.push(trajectory);
      } catch (error) {
        // error-policy:J2 identify the corrupt artifact instead of hiding it from list results
        throw new ElizaError("Failed to read recorded trajectory", {
          code: "TRAJECTORY_LIST_ENTRY_FAILED",
          cause: error,
          context: { trajectoryId: file.id, filePath: file.filePath },
        });
      }
    }
    out.sort((a, b) => b.startedAt - a.startedAt);
    if (opts.limit != null && out.length > opts.limit) {
      return out.slice(0, opts.limit);
    }
    return out;
  }

  private queueFlushTrajectory(trajectory: MutableTrajectory): Promise<void> {
    const trajectoryId = trajectory.trajectoryId;
    const snapshot = cloneTrajectoryValue(trajectory);
    const previous = this.flushQueues.get(trajectoryId) ?? Promise.resolve();
    // error-policy:J5 rejection-suppression — a prior flush's failure (already
    // surfaced inside flushSnapshot) must not chain-block this snapshot's flush.
    const next = previous
      .catch(() => undefined)
      .then(() => this.flushSnapshot(snapshot));
    this.flushQueues.set(trajectoryId, next);
    // error-policy:J5 rejection-suppression — the returned `next` is observed by
    // the caller; this branch only cleans up the queue map without re-surfacing.
    void next
      .finally(() => {
        if (this.flushQueues.get(trajectoryId) === next) {
          this.flushQueues.delete(trajectoryId);
        }
      })
      .catch(() => undefined);
    return next;
  }

  private async flushSnapshot(snapshot: RecordedTrajectory): Promise<void> {
    const filePath = path.join(
      this.rootDir,
      snapshot.agentId,
      trajectoryFileName(snapshot.trajectoryId),
    );
    await atomicWriteJson(filePath, snapshot, this.logger);
    if (!this.markdownEnabled) return;
    const markdownPath = path.join(
      this.markdownDir,
      snapshot.agentId,
      `${snapshot.trajectoryId}.md`,
    );
    await atomicWriteFile(
      markdownPath,
      renderTrajectoryMarkdown(snapshot),
      this.logger,
    );
  }

  private async collectAllFiles(): Promise<
    Array<{ id: string; filePath: string }>
  > {
    const out: Array<{ id: string; filePath: string }> = [];
    const stack: string[] = [this.rootDir];
    try {
      await fs.access(this.rootDir);
    } catch (error) {
      // error-policy:J4 a recorder with no storage directory has no trajectories yet
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
      throw error;
    }

    while (stack.length > 0) {
      const dir = stack.pop();
      if (!dir) continue;
      let entries: import("node:fs").Dirent[];
      try {
        entries = (await fs.readdir(dir, {
          withFileTypes: true,
        })) as import("node:fs").Dirent[];
      } catch (error) {
        // error-policy:J2 preserve directory traversal failures with their path
        throw new ElizaError("Failed to scan trajectory storage", {
          code: "TRAJECTORY_DIRECTORY_READ_FAILED",
          cause: error,
          context: { directory: dir },
        });
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        out.push({
          id: entry.name.replace(/\.json$/, ""),
          filePath: full,
        });
      }
    }

    return out;
  }
}

/**
 * Construct a JSON-file backed `TrajectoryRecorder`. The default rootDir is
 * resolved from `ELIZA_TRAJECTORY_DIR` → `ELIZA_STATE_DIR/trajectories` →
 * `resolveStateDir()/trajectories`.
 *
 * Pass `enabled: false` to short-circuit every method (test fixtures, opt-out
 * at construction time).
 */
export function createJsonFileTrajectoryRecorder(
  opts: CreateJsonFileRecorderOptions = {},
): TrajectoryRecorder {
  return new JsonFileTrajectoryRecorder(opts);
}
