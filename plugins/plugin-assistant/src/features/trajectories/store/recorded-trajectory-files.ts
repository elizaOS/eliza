/**
 * The per-file export of recorded trajectories: one `RecordedTrajectory` JSON
 * file per trajectory under `<trajectory dir>/<agentId>/<id>.json`, plus an
 * optional markdown review sibling. `ELIZA_TRAJECTORY_DIR` consumers read this
 * layout. The row store is the capture owner; these files are its export.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  ElizaError,
  type ListTrajectoriesOptions,
  type RecordedModelCall,
  type RecordedTrajectory,
  type RecorderLogger,
  resolveStateDir,
  stringifyForDiagnostics,
} from "@elizaos/core";

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

  const elizaState = process.env.ELIZA_STATE_DIR?.trim();
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
    Boolean(process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR?.trim())
  );
}

export function resolveTrajectoryMarkdownDir(rootDir: string): string {
  return process.env.ELIZA_TRAJECTORY_MARKDOWN_DIR?.trim() || rootDir;
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

/** The export file path of one recorded trajectory. */
export function recordedTrajectoryFilePath(
  rootDir: string,
  trajectory: Pick<RecordedTrajectory, "agentId" | "trajectoryId">,
): string {
  for (const id of [trajectory.agentId, trajectory.trajectoryId]) {
    if (!id || id === "." || id === ".." || path.win32.basename(id) !== id) {
      throw new ElizaError(
        "A trajectory export identifier must be one path component",
        {
          code: "TRAJECTORY_EXPORT_ID_INVALID",
        },
      );
    }
  }
  return path.join(
    rootDir,
    trajectory.agentId,
    trajectoryFileName(trajectory.trajectoryId),
  );
}

/**
 * Write one recorded trajectory to its export file (atomic rename), and its
 * markdown review sibling when `markdownDir` is given.
 */
export async function writeRecordedTrajectoryFile(
  rootDir: string,
  trajectory: RecordedTrajectory,
  options: { markdownDir?: string; logger?: RecorderLogger } = {},
): Promise<string> {
  const filePath = recordedTrajectoryFilePath(rootDir, trajectory);
  await atomicWriteJson(filePath, trajectory, options.logger);
  if (options.markdownDir) {
    await atomicWriteFile(
      path.join(
        options.markdownDir,
        trajectory.agentId,
        `${trajectory.trajectoryId}.md`,
      ),
      renderTrajectoryMarkdown(trajectory),
      options.logger,
    );
  }
  return filePath;
}

async function collectRecordedTrajectoryFiles(
  rootDir: string,
): Promise<Array<{ id: string; filePath: string }>> {
  const out: Array<{ id: string; filePath: string }> = [];
  const stack: string[] = [rootDir];
  try {
    await fs.access(rootDir);
  } catch (error) {
    // error-policy:J4 an export directory that does not exist has no trajectories yet
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

/** Read one exported recorded trajectory by id, or null when none exists. */
export async function readRecordedTrajectoryFile(
  rootDir: string,
  trajectoryId: string,
): Promise<RecordedTrajectory | null> {
  const files = await collectRecordedTrajectoryFiles(rootDir);
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

/** List exported recorded trajectories, newest first. */
export async function listRecordedTrajectoryFiles(
  rootDir: string,
  opts: ListTrajectoriesOptions = {},
): Promise<RecordedTrajectory[]> {
  const files = await collectRecordedTrajectoryFiles(rootDir);
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
