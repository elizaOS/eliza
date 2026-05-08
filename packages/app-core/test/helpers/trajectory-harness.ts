/**
 * RecordingHarness — opt-in trajectory capture for benchmark + live E2E tests.
 *
 * Wraps `ConversationHarness` with hooks that record:
 *   - The full back-and-forth conversation (every user/agent turn).
 *   - Every `runtime.useModel` call: model, prompt, response, latency, purpose.
 *     Captures the action planner's prompt/response among everything else.
 *   - Lifecycle events: RUN_STARTED/ENDED, ACTION_STARTED/COMPLETED,
 *     EVALUATOR_STARTED/COMPLETED, MODEL_USED.
 *   - Memory creations during the turn (via `runtime.createMemory` wrap).
 *   - Provider snapshots from `runtime.composeState` calls.
 *
 * Capture is opt-in. The default-off gate is `ELIZA_DUMP_TRAJECTORIES=1`,
 * checked in `isTrajectoryCaptureEnabled()`. Tests that want to opt-in
 * unconditionally can pass `force: true` to `RecordingHarness`.
 *
 * Wraps but does not replace `ConversationHarness` — existing consumers of
 * the spy / harness contract remain unaffected.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { AgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { EventType } from "@elizaos/core";
import {
  ConversationHarness,
  type ConversationHarnessOptions,
  type ConversationTurn,
} from "./conversation-harness.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TrajectoryTranscriptEntry {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
  actions?: string[];
}

export interface TrajectoryLlmCall {
  callId: string;
  timestamp: number;
  latencyMs: number;
  modelType: string;
  prompt: string;
  systemPrompt?: string;
  response: string;
  error?: string;
  /** Heuristic classification: "action_planner", "should_respond", "reply", "embedding", "other". */
  purpose: string;
}

export interface TrajectoryProviderSnapshot {
  timestamp: number;
  includeList: string[] | null;
  providers: Array<{
    name: string;
    text?: string;
    valuesKeys?: string[];
    dataKeys?: string[];
  }>;
  text?: string;
}

export interface TrajectoryEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface TrajectoryMemoryWrite {
  timestamp: number;
  tableName: string;
  id?: string;
  entityId?: string;
  roomId?: string;
  contentText?: string;
  contentActions?: string[];
  raw: Record<string, unknown>;
}

export interface TrajectoryActionRecord {
  phase: "started" | "completed";
  actionName: string;
  actionStatus?: string;
  actionId?: string;
  runId?: string;
  /** See ActionSpyCall.actionConfirmationPending. */
  actionConfirmationPending?: boolean;
  timestamp: number;
  contentText?: string;
}

export interface TrajectoryRecord {
  caseId?: string;
  scenarioId?: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  roomId: UUID;
  userId: UUID;
  transcript: TrajectoryTranscriptEntry[];
  agentTrajectory: {
    llmCalls: TrajectoryLlmCall[];
    providerSnapshots: TrajectoryProviderSnapshot[];
  };
  actions: TrajectoryActionRecord[];
  events: TrajectoryEvent[];
  memoriesWritten: TrajectoryMemoryWrite[];
  /** Free-form key/value supplied by the test (expected vs actual, tags…). */
  metadata: Record<string, unknown>;
}

export interface RecordingHarnessOptions extends ConversationHarnessOptions {
  /** Stable identifier for the test case being recorded. */
  caseId?: string;
  /** Optional scenario id for grouping. */
  scenarioId?: string;
  /**
   * When true, capture is enabled regardless of `ELIZA_DUMP_TRAJECTORIES`.
   * When false/undefined, capture follows the env flag — when off, all hooks
   * are no-ops and `dumpTrajectory()` returns an empty record.
   */
  force?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isTrajectoryCaptureEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.ELIZA_DUMP_TRAJECTORIES ?? env.MILADY_TRAJECTORY_REVIEW_MODE)
    ?.trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function isTrajectoryMarkdownReviewEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (
    env.MILADY_TRAJECTORY_REVIEW_MODE ??
    env.MILADY_TRAJECTORY_MARKDOWN ??
    env.ELIZA_TRAJECTORY_MARKDOWN
  )
    ?.trim()
    .toLowerCase();
  return (
    raw === "1" ||
    raw === "true" ||
    raw === "yes" ||
    raw === "on" ||
    Boolean(env.MILADY_TRAJECTORY_MARKDOWN_DIR?.trim())
  );
}

function safeStringify(value: unknown, max = 64_000): string {
  try {
    if (typeof value === "string") return value.slice(0, max);
    const text = JSON.stringify(value, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
  } catch {
    return String(value).slice(0, max);
  }
}

function stringifyTrajectoryRecord(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, currentValue) => {
      if (typeof currentValue === "function") {
        return `[Function ${currentValue.name || "anonymous"}]`;
      }
      if (typeof currentValue === "bigint") {
        return currentValue.toString();
      }
      if (typeof currentValue === "object" && currentValue !== null) {
        if (seen.has(currentValue)) {
          return "[Circular]";
        }
        seen.add(currentValue);
      }
      return currentValue;
    },
    2,
  );
}

function redactMarkdownSecrets(text: string): string {
  const raw =
    process.env.MILADY_TRAJECTORY_MARKDOWN_REDACT?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") {
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

function formatTimestamp(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
  return new Date(timestamp).toISOString();
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return "0ms";
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(2)}s`;
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
    return null;
  }
}

function llmResponseForMarkdown(call: TrajectoryLlmCall): string {
  if (call.purpose === "embedding" || call.modelType === "TEXT_EMBEDDING") {
    const summary = summarizeEmbeddingResponse(call.response);
    if (summary) return summary;
  }
  return call.response;
}

function markdownTableCell(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, "<br>");
}

function renderTrajectoryRecordMarkdown(record: TrajectoryRecord): string {
  const lines: string[] = [];
  lines.push(
    `# Recorded Test Trajectory ${record.caseId ?? record.scenarioId ?? ""}`.trim(),
  );
  lines.push("");
  lines.push(`- case: \`${record.caseId ?? "-"}\``);
  lines.push(`- scenario: \`${record.scenarioId ?? "-"}\``);
  lines.push(`- room: \`${record.roomId}\``);
  lines.push(`- user: \`${record.userId}\``);
  lines.push(`- started: ${formatTimestamp(record.startedAt)}`);
  lines.push(`- ended: ${formatTimestamp(record.endedAt)}`);
  lines.push(`- duration: ${formatDuration(record.durationMs)}`);
  lines.push(
    `- llm calls: ${record.agentTrajectory.llmCalls.length} · actions: ${record.actions.length} · memories: ${record.memoriesWritten.length}`,
  );

  if (Object.keys(record.metadata).length > 0) {
    lines.push("");
    lines.push("## Metadata");
    lines.push("");
    lines.push(...markdownFence(safeStringify(record.metadata), "json"));
  }

  if (record.transcript.length > 0) {
    lines.push("");
    lines.push("## Transcript");
    for (const entry of record.transcript) {
      lines.push("");
      lines.push(`### ${entry.role} (${formatTimestamp(entry.timestamp)})`);
      if (entry.actions?.length) {
        lines.push(
          `- actions: ${entry.actions.map((a) => `\`${a}\``).join(", ")}`,
        );
        lines.push("");
      }
      lines.push(...markdownFence(entry.text));
    }
  }

  if (record.agentTrajectory.llmCalls.length > 0) {
    lines.push("");
    lines.push("## LLM Calls");
    for (const [index, call] of record.agentTrajectory.llmCalls.entries()) {
      lines.push("");
      lines.push(`### Call ${index + 1}: ${call.purpose} (${call.callId})`);
      lines.push("");
      lines.push(`- model type: \`${call.modelType}\``);
      lines.push(`- latency: ${formatDuration(call.latencyMs)}`);
      lines.push(`- timestamp: ${formatTimestamp(call.timestamp)}`);
      if (call.error) lines.push(`- error: ${call.error}`);
      if (call.systemPrompt) {
        lines.push("");
        lines.push("#### System Prompt");
        lines.push("");
        lines.push(...markdownFence(call.systemPrompt));
      }
      lines.push("");
      lines.push("#### Prompt");
      lines.push("");
      lines.push(...markdownFence(call.prompt));
      lines.push("");
      lines.push("#### Response");
      lines.push("");
      lines.push(...markdownFence(llmResponseForMarkdown(call)));
    }
  }

  if (record.actions.length > 0) {
    lines.push("");
    lines.push("## Actions");
    lines.push("");
    lines.push("| Time | Phase | Action | Status | Confirmation | Text |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const action of record.actions) {
      lines.push(
        `| ${formatTimestamp(action.timestamp)} | ${markdownTableCell(action.phase)} | ${markdownTableCell(action.actionName)} | ${markdownTableCell(action.actionStatus)} | ${action.actionConfirmationPending ? "yes" : ""} | ${markdownTableCell(action.contentText)} |`,
      );
    }
  }

  if (record.agentTrajectory.providerSnapshots.length > 0) {
    lines.push("");
    lines.push("## Provider Snapshots");
    for (const [
      index,
      snapshot,
    ] of record.agentTrajectory.providerSnapshots.entries()) {
      lines.push("");
      lines.push(
        `### Snapshot ${index + 1} (${formatTimestamp(snapshot.timestamp)})`,
      );
      lines.push("");
      if (snapshot.includeList) {
        lines.push(
          `- include: ${snapshot.includeList.map((name) => `\`${name}\``).join(", ")}`,
        );
      }
      lines.push(...markdownFence(safeStringify(snapshot), "json"));
    }
  }

  if (record.memoriesWritten.length > 0) {
    lines.push("");
    lines.push("## Memory Writes");
    lines.push("");
    lines.push(...markdownFence(safeStringify(record.memoriesWritten), "json"));
  }

  if (record.events.length > 0) {
    lines.push("");
    lines.push("## Events");
    lines.push("");
    lines.push(...markdownFence(safeStringify(record.events), "json"));
  }

  return `${redactMarkdownSecrets(lines.join("\n")).trimEnd()}\n`;
}

function markdownPathForJson(filePath: string): string {
  if (filePath.endsWith(".json")) {
    return `${filePath.slice(0, -".json".length)}.md`;
  }
  return `${filePath}.md`;
}

function classifyLlmPurpose(
  prompt: string,
  response: string,
  modelType: string,
): string {
  const lowerType = modelType.toLowerCase();
  if (lowerType.includes("embed")) return "embedding";
  const head = prompt.slice(0, 4000).toLowerCase();
  if (
    head.includes("which actions") ||
    head.includes("select the most appropriate action") ||
    head.includes("actions:") ||
    head.includes("available actions") ||
    head.includes("action planner") ||
    head.includes("planner_stage") ||
    head.includes("plan the next native tool calls") ||
    /(^|\n)\s*action\s*:/i.test(response.slice(0, 200))
  ) {
    return "action_planner";
  }
  if (
    head.includes("should the agent respond") ||
    head.includes("respond_to_message") ||
    head.includes("respond_or_ignore")
  ) {
    return "should_respond";
  }
  if (head.includes("you are") && head.includes("respond")) return "reply";
  return "other";
}

function memoryToTranscriptEntry(m: Memory): {
  text: string;
  actions?: string[];
} {
  const text = typeof m.content?.text === "string" ? m.content.text : "";
  const actionsRaw = m.content?.actions;
  const actions = Array.isArray(actionsRaw)
    ? actionsRaw.filter((a): a is string => typeof a === "string")
    : undefined;
  return { text, actions };
}

export function serializeLlmCallResult(result: unknown): {
  response: string;
  error?: string;
} {
  if (result && typeof result === "object") {
    const error = (result as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return {
        response: safeStringify(result),
        error,
      };
    }
  }

  return {
    response: typeof result === "string" ? result : safeStringify(result),
  };
}

// ---------------------------------------------------------------------------
// RecordingHarness
// ---------------------------------------------------------------------------

type UseModelFn = AgentRuntime["useModel"];
type CreateMemoryFn = AgentRuntime["createMemory"];
type ComposeStateFn = AgentRuntime["composeState"];

export class RecordingHarness {
  readonly inner: ConversationHarness;
  readonly enabled: boolean;
  readonly caseId?: string;
  readonly scenarioId?: string;

  private startedAt = 0;
  private endedAt = 0;
  private readonly transcript: TrajectoryTranscriptEntry[] = [];
  private readonly llmCalls: TrajectoryLlmCall[] = [];
  private readonly providerSnapshots: TrajectoryProviderSnapshot[] = [];
  private readonly events: TrajectoryEvent[] = [];
  private readonly memoriesWritten: TrajectoryMemoryWrite[] = [];
  private readonly actionRecords: TrajectoryActionRecord[] = [];
  private readonly metadata: Record<string, unknown> = {};

  private originalUseModel: UseModelFn | null = null;
  private originalCreateMemory: CreateMemoryFn | null = null;
  private originalComposeState: ComposeStateFn | null = null;

  private readonly eventUnsubs: Array<() => void> = [];
  private callCounter = 0;
  private installed = false;

  constructor(runtime: AgentRuntime, opts: RecordingHarnessOptions = {}) {
    this.inner = new ConversationHarness(runtime, opts);
    this.caseId = opts.caseId;
    this.scenarioId = opts.scenarioId;
    this.enabled = opts.force === true || isTrajectoryCaptureEnabled();
  }

  get runtime(): AgentRuntime {
    return this.inner.runtime;
  }

  setMetadata(key: string, value: unknown): void {
    this.metadata[key] = value;
  }

  async setup(): Promise<void> {
    await this.inner.setup();
    if (!this.enabled || this.installed) return;
    this.installInstrumentation();
    this.installed = true;
    this.startedAt = Date.now();
  }

  async send(
    text: string,
    opts?: { timeoutMs?: number },
  ): Promise<ConversationTurn> {
    const turn = await this.inner.send(text, opts);
    if (this.enabled) this.recordTurn(turn);
    return turn;
  }

  private recordTurn(turn: ConversationTurn): void {
    this.transcript.push({
      role: "user",
      text: turn.text,
      timestamp: turn.startedAt,
    });
    const assistantActions = turn.actions
      .filter((a) => a.phase === "completed")
      .map((a) => a.actionName)
      .filter((n) => n.length > 0);
    this.transcript.push({
      role: "assistant",
      text: turn.responseText,
      timestamp: turn.startedAt + turn.durationMs,
      actions: assistantActions.length > 0 ? assistantActions : undefined,
    });
    for (const a of turn.actions) {
      this.actionRecords.push({
        phase: a.phase,
        actionName: a.actionName,
        actionStatus: a.actionStatus,
        actionId: a.actionId,
        runId: a.runId,
        actionConfirmationPending: a.actionConfirmationPending,
        timestamp: a.timestamp,
        contentText:
          typeof a.payload.content?.text === "string"
            ? a.payload.content.text
            : undefined,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Instrumentation
  // -------------------------------------------------------------------------

  private installInstrumentation(): void {
    const runtime = this.inner.runtime;

    // Wrap useModel.
    this.originalUseModel = runtime.useModel.bind(runtime) as UseModelFn;
    const wrappedUseModel = (async (
      modelType: Parameters<UseModelFn>[0],
      params: Parameters<UseModelFn>[1],
    ): Promise<unknown> => {
      const start = Date.now();
      const id = `call-${++this.callCounter}`;
      try {
        const result = await (this.originalUseModel as UseModelFn)(
          modelType,
          params,
        );
        this.recordLlmCall(id, start, modelType as string, params, result);
        return result;
      } catch (err) {
        this.recordLlmCall(id, start, modelType as string, params, {
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }) as UseModelFn;
    (runtime as unknown as { useModel: UseModelFn }).useModel = wrappedUseModel;

    // Wrap createMemory.
    this.originalCreateMemory = runtime.createMemory.bind(
      runtime,
    ) as CreateMemoryFn;
    const wrappedCreateMemory = (async (
      memory: Parameters<CreateMemoryFn>[0],
      tableName: Parameters<CreateMemoryFn>[1],
      unique?: Parameters<CreateMemoryFn>[2],
    ): Promise<UUID> => {
      this.recordMemoryWrite(memory, tableName);
      return (this.originalCreateMemory as CreateMemoryFn)(
        memory,
        tableName,
        unique,
      );
    }) as CreateMemoryFn;
    (runtime as unknown as { createMemory: CreateMemoryFn }).createMemory =
      wrappedCreateMemory;

    // Wrap composeState (records the providers resolved per state composition).
    this.originalComposeState = runtime.composeState.bind(
      runtime,
    ) as ComposeStateFn;
    const wrappedComposeState = (async (
      message: Parameters<ComposeStateFn>[0],
      includeList: Parameters<ComposeStateFn>[1],
      onlyInclude?: Parameters<ComposeStateFn>[2],
      skipCache?: Parameters<ComposeStateFn>[3],
    ): Promise<State> => {
      const result = await (this.originalComposeState as ComposeStateFn)(
        message,
        includeList,
        onlyInclude,
        skipCache,
      );
      this.recordProviderSnapshot(includeList ?? null, result);
      return result;
    }) as ComposeStateFn;
    (runtime as unknown as { composeState: ComposeStateFn }).composeState =
      wrappedComposeState;

    // Subscribe to runtime lifecycle events.
    this.subscribeEvent(EventType.RUN_STARTED, "RUN_STARTED");
    this.subscribeEvent(EventType.RUN_ENDED, "RUN_ENDED");
    this.subscribeEvent(EventType.MODEL_USED, "MODEL_USED");
    this.subscribeEvent(EventType.EVALUATOR_STARTED, "EVALUATOR_STARTED");
    this.subscribeEvent(EventType.EVALUATOR_COMPLETED, "EVALUATOR_COMPLETED");
  }

  private subscribeEvent(eventType: EventType, label: string): void {
    const handler = async (payload: unknown): Promise<void> => {
      const data: Record<string, unknown> = {};
      if (payload && typeof payload === "object") {
        for (const [k, v] of Object.entries(
          payload as Record<string, unknown>,
        )) {
          if (k === "runtime" || typeof v === "function") continue;
          data[k] = v;
        }
      }
      this.events.push({
        type: label,
        timestamp: Date.now(),
        data,
      });
    };
    this.inner.runtime.registerEvent(eventType, handler as never);
    this.eventUnsubs.push(() => {
      try {
        this.inner.runtime.unregisterEvent(eventType, handler as never);
      } catch {
        // best-effort
      }
    });
  }

  private recordLlmCall(
    id: string,
    start: number,
    modelType: string,
    params: unknown,
    result: unknown,
  ): void {
    const paramsRecord =
      params && typeof params === "object"
        ? (params as Record<string, unknown>)
        : {};
    const prompt =
      typeof paramsRecord.prompt === "string"
        ? paramsRecord.prompt
        : safeStringify(paramsRecord);
    const systemPrompt =
      typeof paramsRecord.systemPrompt === "string"
        ? paramsRecord.systemPrompt
        : undefined;
    const serializedResult = serializeLlmCallResult(result);
    this.llmCalls.push({
      callId: id,
      timestamp: start,
      latencyMs: Date.now() - start,
      modelType,
      prompt,
      systemPrompt,
      response: serializedResult.response,
      error: serializedResult.error,
      purpose: classifyLlmPurpose(prompt, serializedResult.response, modelType),
    });
  }

  private recordMemoryWrite(memory: Memory, tableName: string): void {
    const entry = memoryToTranscriptEntry(memory);
    this.memoriesWritten.push({
      timestamp: Date.now(),
      tableName,
      id: memory.id,
      entityId: memory.entityId,
      roomId: memory.roomId,
      contentText: entry.text || undefined,
      contentActions: entry.actions,
      raw: {
        content: memory.content,
        metadata: memory.metadata,
      },
    });
  }

  private recordProviderSnapshot(
    includeList: string[] | null,
    state: State,
  ): void {
    const dataRecord =
      state.data && typeof state.data === "object"
        ? (state.data as { providers?: Record<string, unknown> })
        : { providers: undefined };
    const providersBlock = (dataRecord.providers ?? {}) as Record<
      string,
      unknown
    >;
    const providers: TrajectoryProviderSnapshot["providers"] = [];
    for (const [name, value] of Object.entries(providersBlock)) {
      if (!value || typeof value !== "object") {
        providers.push({ name, text: safeStringify(value, 1000) });
        continue;
      }
      const v = value as {
        text?: unknown;
        values?: Record<string, unknown>;
        data?: Record<string, unknown>;
      };
      providers.push({
        name,
        text: typeof v.text === "string" ? v.text.slice(0, 4000) : undefined,
        valuesKeys: v.values ? Object.keys(v.values) : undefined,
        dataKeys: v.data ? Object.keys(v.data) : undefined,
      });
    }
    this.providerSnapshots.push({
      timestamp: Date.now(),
      includeList,
      providers,
      text:
        typeof state.text === "string" ? state.text.slice(0, 8000) : undefined,
    });
  }

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  dumpTrajectory(): TrajectoryRecord {
    if (!this.endedAt) this.endedAt = Date.now();
    return {
      caseId: this.caseId,
      scenarioId: this.scenarioId,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      durationMs: Math.max(0, this.endedAt - this.startedAt),
      roomId: this.inner.roomId,
      userId: this.inner.userId,
      transcript: [...this.transcript],
      agentTrajectory: {
        llmCalls: [...this.llmCalls],
        providerSnapshots: [...this.providerSnapshots],
      },
      actions: [...this.actionRecords],
      events: [...this.events],
      memoriesWritten: [...this.memoriesWritten],
      metadata: { ...this.metadata },
    };
  }

  async writeTrajectoryToFile(filePath: string): Promise<void> {
    const record = this.dumpTrajectory();
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, stringifyTrajectoryRecord(record), "utf8");
    if (isTrajectoryMarkdownReviewEnabled()) {
      await fs.writeFile(
        markdownPathForJson(filePath),
        renderTrajectoryRecordMarkdown(record),
        "utf8",
      );
    }
  }

  async cleanup(): Promise<void> {
    this.endedAt = Date.now();
    if (this.installed) {
      const runtime = this.inner.runtime;
      if (this.originalUseModel) {
        (runtime as unknown as { useModel: UseModelFn }).useModel =
          this.originalUseModel;
      }
      if (this.originalCreateMemory) {
        (runtime as unknown as { createMemory: CreateMemoryFn }).createMemory =
          this.originalCreateMemory;
      }
      if (this.originalComposeState) {
        (runtime as unknown as { composeState: ComposeStateFn }).composeState =
          this.originalComposeState;
      }
      for (const unsub of this.eventUnsubs.splice(0)) unsub();
      this.installed = false;
    }
    await this.inner.cleanup();
  }
}
