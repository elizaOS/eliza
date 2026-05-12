/**
 * Codex CLI session reader — closes the W1-T2 / C1 Codex path.
 *
 * Codex's `codex exec` CLI writes two complementary on-disk surfaces per
 * non-interactive session:
 *
 *   1. A **rollout JSONL** under
 *      `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`.
 *      Each line is one event — `session_meta`, `turn_context`,
 *      `response_item` (message / reasoning / function_call /
 *      function_call_output), `event_msg` (`task_started`, `task_complete`,
 *      `agent_message`, `agent_reasoning`, `token_count`, …), etc.
 *   2. A **last-message file** at the path passed via `--output-last-message`.
 *      Plain-text dump of the final assistant message. Useful as a
 *      fall-through completion signal when the rollout JSONL is unavailable
 *      (older Codex versions, redirected `$CODEX_HOME`, etc.).
 *
 * The PTY service already provisions a per-session `$CODEX_HOME` and a temp
 * file for `--output-last-message`. This module is the *reader* half of CQRS
 * for the Codex trajectory-capture path. It:
 *
 *   1. Locates rollout JSONL files for the given Codex home. We deliberately
 *      probe both the canonical `sessions/YYYY/MM/DD/*.jsonl` layout *and*
 *      the flat `sessions/*.jsonl` fallback older Codex builds emit, so we
 *      don't drop traces when a user updates the CLI between sessions.
 *   2. Parses each JSONL line into a strongly-typed event union.
 *   3. Optionally folds in the `--output-last-message` file as a synthetic
 *      final text step when the rollout doesn't terminate with one.
 *   4. Normalizes assistant messages, reasoning blocks, function_calls, and
 *      function_call_outputs into trajectory step records the runtime can
 *      persist as child steps of the parent step pointed at by
 *      `ELIZA_PARENT_TRAJECTORY_STEP_ID`.
 *
 * Privacy:
 *   The trajectory DB stores the user's own data on their own machine
 *   (see AGENTS.md A2). The privacy filter runs on the *export* path
 *   (training format step / HF publish), not here. This module emits
 *   raw normalized steps; downstream pipelines redact.
 *
 * Errors:
 *   Missing rollout dir / last-message file is NOT an error — the reader
 *   returns an empty result with a `reason` set to `"missing"`. Malformed
 *   lines are skipped with a logger warning; the rest of the file still
 *   parses. Per the W1-T2 brief, a partial-capture result is tagged
 *   `captureQuality: "degraded"` so downstream filters can downweight it.
 *
 * @module services/codex-trajectory-reader
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Strong types for Codex's rollout shape
// ---------------------------------------------------------------------------

/**
 * Token usage block emitted on Codex `token_count` event_msg payloads. Field
 * names mirror the upstream OpenAI / Codex shape exactly so we don't have
 * to invent synonyms or alias them.
 */
export interface CodexTokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

export interface CodexInputTextBlock {
  type: "input_text";
  text: string;
}

export interface CodexOutputTextBlock {
  type: "output_text";
  text: string;
}

export type CodexMessageContentBlock =
  | CodexInputTextBlock
  | CodexOutputTextBlock;

export interface CodexMessageItem {
  type: "message";
  role: "user" | "assistant" | "developer" | "system";
  content: CodexMessageContentBlock[];
  /** Optional phase tag: `commentary` for in-progress narration, `final` for the closing message. */
  phase?: string;
}

export interface CodexReasoningItem {
  type: "reasoning";
  /** Free-form summary entries Codex includes when reasoning is summarized. */
  summary?: Array<{ type?: string; text?: string }>;
  /** Plain-text body when the reasoning is not encrypted. */
  content?: string | null;
  /** Encrypted reasoning blob — Codex sometimes ships this in place of `content`. */
  encrypted_content?: string;
}

export interface CodexFunctionCallItem {
  type: "function_call";
  name: string;
  /** Stringified JSON; Codex serialized into a string for transport. */
  arguments: string;
  call_id: string;
}

export interface CodexFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export interface CodexCustomToolCallItem {
  type: "custom_tool_call";
  name: string;
  arguments?: string;
  call_id: string;
}

export interface CodexCustomToolCallOutputItem {
  type: "custom_tool_call_output";
  call_id: string;
  output: string;
}

export type CodexResponseItemPayload =
  | CodexMessageItem
  | CodexReasoningItem
  | CodexFunctionCallItem
  | CodexFunctionCallOutputItem
  | CodexCustomToolCallItem
  | CodexCustomToolCallOutputItem;

export interface CodexResponseItemEvent {
  type: "response_item";
  timestamp: string;
  payload: CodexResponseItemPayload;
}

export interface CodexEventMsgTaskStarted {
  type: "task_started";
  turn_id: string;
  model_context_window?: number;
}

export interface CodexEventMsgTaskComplete {
  type: "task_complete";
  turn_id: string;
  last_agent_message?: string;
}

export interface CodexEventMsgTokenCount {
  type: "token_count";
  info: {
    total_token_usage?: CodexTokenUsage;
    last_token_usage?: CodexTokenUsage;
    model_context_window?: number;
  } | null;
}

export interface CodexEventMsgAgentMessage {
  type: "agent_message";
  message: string;
}

export interface CodexEventMsgAgentReasoning {
  type: "agent_reasoning";
  text: string;
}

export interface CodexEventMsgOther {
  type: string;
  [key: string]: unknown;
}

export type CodexEventMsgPayload =
  | CodexEventMsgTaskStarted
  | CodexEventMsgTaskComplete
  | CodexEventMsgTokenCount
  | CodexEventMsgAgentMessage
  | CodexEventMsgAgentReasoning
  | CodexEventMsgOther;

export interface CodexEventMsgEvent {
  type: "event_msg";
  timestamp: string;
  payload: CodexEventMsgPayload;
}

export interface CodexSessionMetaEvent {
  type: "session_meta";
  timestamp: string;
  payload: {
    id?: string;
    timestamp?: string;
    cwd?: string;
    cli_version?: string;
    model_provider?: string;
    [key: string]: unknown;
  };
}

export interface CodexTurnContextEvent {
  type: "turn_context";
  timestamp: string;
  payload: {
    turn_id: string;
    cwd?: string;
    model?: string;
    effort?: string;
    [key: string]: unknown;
  };
}

export interface CodexOtherEvent {
  type: string;
  timestamp?: string;
  [key: string]: unknown;
}

export type CodexSessionEvent =
  | CodexSessionMetaEvent
  | CodexTurnContextEvent
  | CodexResponseItemEvent
  | CodexEventMsgEvent
  | CodexOtherEvent;

// ---------------------------------------------------------------------------
// Normalized output shape — must match shape emitted by session-log-reader so
// trajectory consumers can be agent-agnostic.
// ---------------------------------------------------------------------------

export type CodexNormalizedStepKind =
  | "reasoning"
  | "text"
  | "tool_call"
  | "tool_result";

/**
 * One normalized trajectory step. Shape is intentionally aligned with the
 * Claude Code session-log-reader's `NormalizedTrajectoryStep`. Same writer
 * (`mergeCodexSessionIntoTrajectory`) can therefore reuse the same shape on
 * the merge path.
 */
export interface NormalizedCodexTrajectoryStep {
  /** Stable child id derived from the rollout event sequence. */
  stepId: string;
  /** Coarse step kind for the trajectory viewer + training format. */
  kind: CodexNormalizedStepKind;
  /** Wall-clock ms from the rollout event timestamp. */
  timestamp: number;
  /** Provenance tag, always `"codex"` for this module. */
  source: "codex";
  /** Codex session id (`session_meta.payload.id`). */
  sessionId: string;
  /** Codex turn id at the moment the event was emitted. */
  turnId?: string;
  /** Model name from the most recent `turn_context.model`. */
  model?: string;
  /** Token usage carried from the closest preceding `token_count` event. */
  usage?: CodexTokenUsage;
  /** Reasoning body (kind === "reasoning"). May be empty when Codex only emits encrypted content. */
  reasoning?: string;
  /** Whether the reasoning was encrypted (kind === "reasoning"). */
  reasoningEncrypted?: boolean;
  /** Assistant text (kind === "text"). */
  text?: string;
  /** Phase tag on assistant messages (`commentary` | `final`). */
  phase?: string;
  /** Tool call name (kind === "tool_call"). */
  toolName?: string;
  /** Parsed tool call args (kind === "tool_call"). `undefined` if the raw `arguments` string is not valid JSON. */
  toolInput?: Record<string, unknown>;
  /** Raw arguments string Codex emitted (always present on tool_call). */
  toolInputRaw?: string;
  /** Tool call id linking to the matching function_call_output row. */
  toolUseId?: string;
  /** Whether the call originated from `custom_tool_call`. */
  toolCustom?: boolean;
  /** Tool result content (kind === "tool_result"). */
  toolResult?: string;
}

export type CodexCaptureQuality = "ok" | "degraded";

export interface CodexSessionReadResult {
  /** Steps in original rollout order. Empty when nothing was read. */
  steps: NormalizedCodexTrajectoryStep[];
  /** Absolute path of the rollout JSONL we parsed, when one was found. */
  rolloutPath?: string;
  /** Absolute path of the `--output-last-message` file when present. */
  lastMessagePath?: string;
  /** Codex session id from the rollout's `session_meta`. */
  sessionId?: string;
  /** Distinct model ids seen across `turn_context` events. */
  models: string[];
  /** Aggregated token usage from `token_count` events. */
  totalUsage: CodexTokenUsage;
  /** The final `last_agent_message` Codex announced (or the `--output-last-message` body). */
  finalMessage?: string;
  /** When we returned nothing, why. */
  reason?: "missing" | "empty" | "ok";
  /**
   * Tagged so downstream filters can downweight degraded captures. Set to
   * `"degraded"` when one or more sources are missing or partially
   * unreadable; `"ok"` when everything resolved cleanly.
   */
  captureQuality: CodexCaptureQuality;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

interface CodexRolloutFileEntry {
  filePath: string;
  mtimeMs: number;
}

interface CodexTrajectoryReaderLogger {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

const NOOP_LOGGER: CodexTrajectoryReaderLogger = {};

async function listJsonlFilesIn(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Recursively walk `sessions/YYYY/MM/DD/*.jsonl` plus any flat `sessions/*`
 * fallback. Keeps each candidate's mtime so the caller can pick the most
 * recent one.
 */
async function walkCodexSessionsDir(
  sessionsDir: string,
  logger: CodexTrajectoryReaderLogger,
): Promise<CodexRolloutFileEntry[]> {
  const found: CodexRolloutFileEntry[] = [];
  const stack: string[] = [sessionsDir];
  // Bound recursion at four levels deep (sessions/YYYY/MM/DD/file) so a
  // malicious symlink loop can't hang the reader. Codex never nests deeper.
  const MAX_DEPTH = 4;
  // Track entries we've visited as `dir@depth` to short-circuit cycles.
  const visited = new Set<string>();

  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    const depthFromRoot =
      dir === sessionsDir
        ? 0
        : dir.replace(`${sessionsDir}/`, "").split("/").length;
    if (depthFromRoot > MAX_DEPTH) continue;
    if (visited.has(dir)) continue;
    visited.add(dir);

    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn?.(
          `[codex-trajectory-reader] failed to read ${dir}: ${(err as Error).message}`,
        );
      }
      continue;
    }

    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(child);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      try {
        const info = await stat(child);
        found.push({ filePath: child, mtimeMs: info.mtimeMs });
      } catch (err) {
        logger.warn?.(
          `[codex-trajectory-reader] failed to stat ${child}: ${(err as Error).message}`,
        );
      }
    }
  }

  return found;
}

/**
 * Find the most recently modified Codex rollout JSONL under `codexHome`.
 * Returns `null` when no rollout exists. Probes both the canonical nested
 * `sessions/YYYY/MM/DD/...` layout and a flat `sessions/*.jsonl` fallback
 * older Codex builds emit.
 */
export async function findCodexRolloutFile(
  codexHome: string,
  logger: CodexTrajectoryReaderLogger = NOOP_LOGGER,
): Promise<CodexRolloutFileEntry | null> {
  const sessionsDir = join(codexHome, "sessions");
  const nested = await walkCodexSessionsDir(sessionsDir, logger);
  const flat = await listJsonlFilesIn(sessionsDir);

  const found: CodexRolloutFileEntry[] = [...nested];
  for (const filePath of flat) {
    try {
      const info = await stat(filePath);
      found.push({ filePath, mtimeMs: info.mtimeMs });
    } catch (err) {
      logger.warn?.(
        `[codex-trajectory-reader] failed to stat ${filePath}: ${(err as Error).message}`,
      );
    }
  }

  if (found.length === 0) return null;
  // Deduplicate — `walkCodexSessionsDir` and `listJsonlFilesIn` overlap when
  // a flat file sits directly under `sessions/`.
  const byPath = new Map<string, CodexRolloutFileEntry>();
  for (const entry of found) {
    const existing = byPath.get(entry.filePath);
    if (!existing || existing.mtimeMs < entry.mtimeMs) {
      byPath.set(entry.filePath, entry);
    }
  }
  const unique = [...byPath.values()];
  unique.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return unique[0];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function parseTimestamp(value: unknown): number {
  if (typeof value !== "string") return Date.now();
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function asTokenUsage(value: unknown): CodexTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const out: CodexTokenUsage = {};
  for (const key of [
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
  ] as const) {
    const n = asNumber(value[key]);
    if (n !== undefined) out[key] = n;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Parse one JSONL line. Returns `null` for blank or malformed lines or rows
 * that lack the required top-level `type` string. We don't throw — a single
 * bad line in a long transcript shouldn't drop the whole capture.
 */
export function parseCodexSessionLine(line: string): CodexSessionEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.type !== "string") return null;

  // We cast to CodexSessionEvent rather than reconstructing the row field by
  // field — the upstream Codex schema is large and mostly additive. The
  // normalization layer pulls out exactly the fields we care about.
  return raw as unknown as CodexSessionEvent;
}

/**
 * Parse the full rollout JSONL at `filePath`. Malformed lines are dropped
 * with a debug log; an entirely unreadable file returns an empty array (the
 * caller decides whether that's a hard error or a degraded-capture case).
 */
export async function parseCodexRolloutFile(
  filePath: string,
  logger: CodexTrajectoryReaderLogger = NOOP_LOGGER,
): Promise<CodexSessionEvent[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    logger.warn?.(
      `[codex-trajectory-reader] failed to read ${filePath}: ${(err as Error).message}`,
    );
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const events: CodexSessionEvent[] = [];
  let dropped = 0;
  for (const line of lines) {
    const parsed = parseCodexSessionLine(line);
    if (parsed) {
      events.push(parsed);
    } else if (line.trim().length > 0) {
      dropped += 1;
    }
  }
  if (dropped > 0) {
    logger.debug?.(
      `[codex-trajectory-reader] ${filePath}: dropped ${dropped} malformed lines`,
    );
  }
  return events;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function tryParseJson(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function makeCodexChildStepId(
  parentStepId: string,
  idx: number,
  hint: string | undefined,
): string {
  // Compose a stable, parent-scoped child id. We don't get a per-event uuid
  // from Codex the way Claude Code transcripts do, so we fall back to the
  // event's `call_id` / `turn_id` / sequence index — whichever is present.
  const slug = hint && hint.length > 0 ? hint.slice(0, 12) : `n${idx}`;
  return `${parentStepId}-codex-${idx.toString().padStart(4, "0")}-${slug}`;
}

/**
 * Normalize a parsed Codex rollout into trajectory step records.
 *
 * - `response_item.message` (assistant) → `text` step (one per `output_text` block).
 * - `response_item.reasoning` → `reasoning` step. If only `encrypted_content`
 *   is present we still emit the step with `reasoning: ""` and
 *   `reasoningEncrypted: true` so the trainer can downweight or skip.
 * - `response_item.function_call` / `custom_tool_call` → `tool_call` step.
 * - `response_item.function_call_output` / `custom_tool_call_output` →
 *   `tool_result` step linked via `toolUseId === call_id`.
 * - `event_msg.agent_message` / `agent_reasoning` are dropped — they
 *   duplicate the rollout's `response_item.message` / `response_item.reasoning`
 *   rows.
 *
 * Token usage and model name are tracked across the stream:
 * `turn_context.model` becomes the active model, `event_msg.token_count`
 * becomes the active usage. Each emitted step carries the latest values seen
 * before the event in the rollout's wall-clock order.
 */
export function normalizeCodexEvents(
  events: CodexSessionEvent[],
  parentStepId: string,
): NormalizedCodexTrajectoryStep[] {
  const out: NormalizedCodexTrajectoryStep[] = [];
  let idx = 0;
  let activeModel: string | undefined;
  let activeTurn: string | undefined;
  let activeUsage: CodexTokenUsage | undefined;
  let sessionId = "";

  for (const event of events) {
    if (event.type === "session_meta") {
      const meta = (event as CodexSessionMetaEvent).payload;
      if (meta && typeof meta.id === "string") sessionId = meta.id;
      continue;
    }

    if (event.type === "turn_context") {
      const ctx = (event as CodexTurnContextEvent).payload;
      const model = asString(ctx?.model);
      if (model) activeModel = model;
      const turnId = asString(ctx?.turn_id);
      if (turnId) activeTurn = turnId;
      continue;
    }

    if (event.type === "event_msg") {
      const payload = (event as CodexEventMsgEvent).payload;
      const subType = (payload as { type?: unknown }).type;
      if (subType === "token_count") {
        const info = (payload as CodexEventMsgTokenCount).info;
        if (info) {
          const total = asTokenUsage(info.total_token_usage);
          if (total) activeUsage = total;
        }
      } else if (subType === "task_started") {
        const turnId = asString((payload as CodexEventMsgTaskStarted).turn_id);
        if (turnId) activeTurn = turnId;
      }
      // agent_message + agent_reasoning duplicate response_item rows, drop.
      continue;
    }

    if (event.type !== "response_item") continue;
    const item = (event as CodexResponseItemEvent).payload;
    const ts = parseTimestamp(event.timestamp);

    if (item.type === "message") {
      if (item.role !== "assistant") continue;
      for (const block of item.content ?? []) {
        if (block.type !== "output_text") continue;
        const text = asString(block.text);
        if (typeof text !== "string") continue;
        out.push({
          stepId: makeCodexChildStepId(parentStepId, idx, activeTurn),
          kind: "text",
          timestamp: ts,
          source: "codex",
          sessionId,
          turnId: activeTurn,
          model: activeModel,
          usage: activeUsage,
          text,
          ...(item.phase ? { phase: item.phase } : {}),
        });
        idx += 1;
      }
      continue;
    }

    if (item.type === "reasoning") {
      const direct = asString(item.content);
      const encrypted = asString(item.encrypted_content);
      const summary = Array.isArray(item.summary)
        ? item.summary
            .map((part) => asString(part?.text))
            .filter((part): part is string => Boolean(part))
            .join("\n")
        : undefined;
      const reasoning = direct ?? summary ?? "";
      const isEncrypted =
        !direct && (summary ?? "").length === 0 && Boolean(encrypted);
      out.push({
        stepId: makeCodexChildStepId(parentStepId, idx, activeTurn),
        kind: "reasoning",
        timestamp: ts,
        source: "codex",
        sessionId,
        turnId: activeTurn,
        model: activeModel,
        usage: activeUsage,
        reasoning,
        reasoningEncrypted: isEncrypted,
      });
      idx += 1;
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const args = asString(item.arguments) ?? "";
      const parsed = args ? tryParseJson(args) : undefined;
      out.push({
        stepId: makeCodexChildStepId(parentStepId, idx, item.call_id),
        kind: "tool_call",
        timestamp: ts,
        source: "codex",
        sessionId,
        turnId: activeTurn,
        model: activeModel,
        usage: activeUsage,
        toolName: item.name,
        toolInput: parsed,
        toolInputRaw: args,
        toolUseId: item.call_id,
        toolCustom: item.type === "custom_tool_call",
      });
      idx += 1;
      continue;
    }

    if (
      item.type === "function_call_output" ||
      item.type === "custom_tool_call_output"
    ) {
      out.push({
        stepId: makeCodexChildStepId(parentStepId, idx, item.call_id),
        kind: "tool_result",
        timestamp: ts,
        source: "codex",
        sessionId,
        turnId: activeTurn,
        toolUseId: item.call_id,
        toolResult: asString(item.output) ?? "",
        toolCustom: item.type === "custom_tool_call_output",
      });
      idx += 1;
    }
  }

  return out;
}

function extractDistinctModels(
  steps: NormalizedCodexTrajectoryStep[],
): string[] {
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.model && !seen.has(step.model)) seen.add(step.model);
  }
  return [...seen];
}

function aggregateUsage(events: CodexSessionEvent[]): CodexTokenUsage {
  const total: CodexTokenUsage = {};
  let lastTotal: CodexTokenUsage | undefined;
  for (const event of events) {
    if (event.type !== "event_msg") continue;
    const payload = (event as CodexEventMsgEvent).payload;
    if (
      (payload as { type?: unknown }).type !== "token_count" ||
      !(payload as CodexEventMsgTokenCount).info
    ) {
      continue;
    }
    const info = (payload as CodexEventMsgTokenCount).info;
    if (!info) continue;
    const candidate = asTokenUsage(info.total_token_usage);
    if (candidate) lastTotal = candidate;
  }
  // Codex's `total_token_usage` is already cumulative across the session,
  // so the *last* value is the right grand total — adding per-event would
  // double-count.
  if (lastTotal) {
    for (const key of Object.keys(lastTotal) as Array<keyof CodexTokenUsage>) {
      const value = lastTotal[key];
      if (typeof value === "number") total[key] = value;
    }
  }
  return total;
}

function extractFinalMessageFromRollout(
  events: CodexSessionEvent[],
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type !== "event_msg") continue;
    const payload = (event as CodexEventMsgEvent).payload;
    if ((payload as { type?: unknown }).type !== "task_complete") continue;
    const finalMessage = asString(
      (payload as CodexEventMsgTaskComplete).last_agent_message,
    );
    if (finalMessage) return finalMessage;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// High-level reader (the entry point the PTY hook calls)
// ---------------------------------------------------------------------------

export interface ReadCodexSessionOptions {
  /** Working directory the PTY session ran in. Used purely for diagnostics. */
  workspaceDir: string;
  /** Codex home for the spawned session (per-session temp dir Eliza provisions). */
  codexHome: string;
  /** Parent trajectory step id to anchor the merged child steps to. */
  parentStepId: string;
  /** Optional logger for diagnostic warnings. */
  logger?: CodexTrajectoryReaderLogger;
  /** Optional explicit rollout file path (skips directory discovery). */
  explicitRolloutPath?: string;
  /** Path of the `--output-last-message` file when set by the PTY service. */
  lastMessagePath?: string;
}

async function readLastMessageFile(
  path: string | undefined,
  logger: CodexTrajectoryReaderLogger,
): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const raw = await readFile(path, "utf8");
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn?.(
        `[codex-trajectory-reader] failed to read last-message file ${path}: ${(err as Error).message}`,
      );
    }
    return undefined;
  }
}

/**
 * Locate, parse, and normalize a Codex `codex exec` session into trajectory
 * steps anchored under `parentStepId`. Idempotent — call as many times as
 * you like; parsed files aren't mutated.
 *
 * Interactive Codex sessions (no `--output-last-message`) should NOT call
 * this — the PTY service is responsible for skipping them. The reader will
 * still work if you call it: it will just attempt rollout discovery and may
 * succeed if Codex wrote sessions under `codexHome`.
 */
export async function readCodexSession(
  options: ReadCodexSessionOptions,
): Promise<CodexSessionReadResult> {
  const { codexHome, parentStepId, logger = NOOP_LOGGER } = options;

  let rolloutPath: string | undefined = options.explicitRolloutPath;
  if (!rolloutPath) {
    const located = await findCodexRolloutFile(codexHome, logger);
    rolloutPath = located?.filePath;
  }

  const lastMessage = await readLastMessageFile(
    options.lastMessagePath,
    logger,
  );

  if (!rolloutPath) {
    // Degraded capture path: rollout missing. If we have a last-message
    // file, emit it as a single synthetic `text` step so the parent
    // trajectory at least captures the final answer.
    if (lastMessage) {
      return {
        steps: [
          {
            stepId: makeCodexChildStepId(parentStepId, 0, "final"),
            kind: "text",
            timestamp: Date.now(),
            source: "codex",
            sessionId: "",
            text: lastMessage,
            phase: "final",
          },
        ],
        lastMessagePath: options.lastMessagePath,
        finalMessage: lastMessage,
        models: [],
        totalUsage: {},
        reason: "ok",
        captureQuality: "degraded",
      };
    }
    return {
      steps: [],
      lastMessagePath: options.lastMessagePath,
      models: [],
      totalUsage: {},
      reason: "missing",
      captureQuality: "degraded",
    };
  }

  const events = await parseCodexRolloutFile(rolloutPath, logger);
  if (events.length === 0) {
    if (lastMessage) {
      return {
        steps: [
          {
            stepId: makeCodexChildStepId(parentStepId, 0, "final"),
            kind: "text",
            timestamp: Date.now(),
            source: "codex",
            sessionId: "",
            text: lastMessage,
            phase: "final",
          },
        ],
        rolloutPath,
        lastMessagePath: options.lastMessagePath,
        finalMessage: lastMessage,
        models: [],
        totalUsage: {},
        reason: "ok",
        captureQuality: "degraded",
      };
    }
    return {
      steps: [],
      rolloutPath,
      lastMessagePath: options.lastMessagePath,
      models: [],
      totalUsage: {},
      reason: "empty",
      captureQuality: "degraded",
    };
  }

  const steps = normalizeCodexEvents(events, parentStepId);
  const finalFromRollout = extractFinalMessageFromRollout(events);
  // Prefer the last-message file when available — it's the authoritative
  // surface Codex exposes for non-interactive runs. Fall back to whatever
  // we extracted from the rollout's `task_complete` event.
  const finalMessage = lastMessage ?? finalFromRollout;

  // If the rollout doesn't end with the final assistant text but we have one
  // from the last-message file, append it as a synthetic terminal step. This
  // happens when Codex flushes the rollout before the `task_complete`
  // event_msg lands.
  const hasFinalText = steps.some(
    (step) =>
      step.kind === "text" &&
      typeof step.text === "string" &&
      finalMessage !== undefined &&
      step.text.trim() === finalMessage.trim(),
  );
  if (lastMessage && !hasFinalText) {
    steps.push({
      stepId: makeCodexChildStepId(parentStepId, steps.length, "final"),
      kind: "text",
      timestamp: Date.now(),
      source: "codex",
      sessionId:
        events.find(
          (event): event is CodexSessionMetaEvent =>
            event.type === "session_meta",
        )?.payload?.id ?? "",
      text: lastMessage,
      phase: "final",
    });
  }

  const sessionMeta = events.find(
    (event): event is CodexSessionMetaEvent => event.type === "session_meta",
  );

  // Capture quality is degraded when either source is missing. We tolerate
  // either a missing last-message file (older Codex builds without
  // `--output-last-message`) or a missing rollout, but we flag it.
  const captureQuality: CodexCaptureQuality =
    options.lastMessagePath && !lastMessage ? "degraded" : "ok";

  return {
    steps,
    rolloutPath,
    lastMessagePath: options.lastMessagePath,
    sessionId: sessionMeta?.payload?.id,
    models: extractDistinctModels(steps),
    totalUsage: aggregateUsage(events),
    finalMessage,
    reason: steps.length > 0 ? "ok" : "empty",
    captureQuality,
  };
}
