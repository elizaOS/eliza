/**
 * Claude Code session log reader — closes the W1-T1 / C1 gap.
 *
 * Claude Code writes a full JSONL transcript of every PTY session it owns
 * to `~/.claude/projects/<encoded-workdir>/<session-uuid>.jsonl`. The PTY
 * service today injects `ELIZA_PARENT_TRAJECTORY_STEP_ID` into the spawn
 * env but never reads those logs back, so reasoning blocks, tool calls,
 * and per-call token usage are discarded — the parent trajectory only
 * captures ANSI-stripped stdout.
 *
 * This module is the *reader* half of CQRS for that capture path. It:
 *
 *   1. Locates session-log files for a given workdir. Two locations are
 *      probed, in order:
 *        - `~/.claude/projects/<encoded(workdir)>/*.jsonl` (canonical,
 *           per current Claude Code releases).
 *        - `<workdir>/.claude/session-logs/*.{json,jsonl}` (workspace-
 *           local fallback that older docs reference).
 *   2. Parses each JSONL line into a strongly-typed event union.
 *   3. Normalizes assistant + user turns into trajectory step records the
 *      runtime can persist as child steps of the parent step pointed at by
 *      `ELIZA_PARENT_TRAJECTORY_STEP_ID`.
 *
 * Privacy:
 *   The trajectory DB stores the user's own data on their own machine
 *   (see AGENTS.md A2). The privacy filter runs on the *export* path
 *   (training format step / HF publish), not here. This module emits
 *   raw normalized steps; downstream pipelines redact.
 *
 * Errors:
 *   Missing session-log directory is NOT an error — the reader returns
 *   an empty result with a `reason` set to `"missing"`. Malformed lines
 *   are skipped with a logger warning; the rest of the file still parses.
 *
 * @module services/session-log-reader
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Strong types for Claude Code's session-log shape
// ---------------------------------------------------------------------------

/**
 * Token usage block emitted on every assistant message. Field names mirror
 * the upstream Anthropic streaming schema exactly so we don't have to invent
 * synonyms or alias them.
 */
export interface ClaudeCodeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ClaudeCodeTextBlock {
  type: "text";
  text: string;
}

export interface ClaudeCodeThinkingBlock {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface ClaudeCodeToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ClaudeCodeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

export type ClaudeCodeContentBlock =
  | ClaudeCodeTextBlock
  | ClaudeCodeThinkingBlock
  | ClaudeCodeToolUseBlock
  | ClaudeCodeToolResultBlock;

export interface ClaudeCodeAssistantMessage {
  role: "assistant";
  id?: string;
  model?: string;
  content: ClaudeCodeContentBlock[];
  stop_reason?: string;
  usage?: ClaudeCodeUsage;
}

export interface ClaudeCodeUserMessage {
  role: "user";
  content: string | ClaudeCodeContentBlock[];
}

export interface ClaudeCodeAssistantEvent {
  type: "assistant";
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  cwd?: string;
  message: ClaudeCodeAssistantMessage;
  /** Anthropic API request id; useful for cross-referencing telemetry. */
  requestId?: string;
}

export interface ClaudeCodeUserEvent {
  type: "user";
  uuid: string;
  parentUuid: string | null;
  timestamp: string;
  sessionId: string;
  cwd?: string;
  message: ClaudeCodeUserMessage;
  toolUseResult?: unknown;
}

/**
 * The session log also includes housekeeping rows we don't care about —
 * queue operations, summary entries, etc. They're surfaced as `unknown`
 * here so the parser doesn't reject the whole file.
 */
export interface ClaudeCodeOtherEvent {
  type: string;
  [key: string]: unknown;
}

export type ClaudeCodeSessionEvent =
  | ClaudeCodeAssistantEvent
  | ClaudeCodeUserEvent
  | ClaudeCodeOtherEvent;

// ---------------------------------------------------------------------------
// Normalized output shape (what the rest of the trajectory pipeline reads)
// ---------------------------------------------------------------------------

export type NormalizedStepKind =
  | "reasoning"
  | "text"
  | "tool_call"
  | "tool_result";

/**
 * One normalized trajectory step. The shape is deliberately flat so callers
 * can persist it without having to know which underlying agent the session
 * came from. Codex / OpenCode parsers will produce the same shape.
 */
export interface NormalizedTrajectoryStep {
  /** Stable child id derived from the Claude Code message uuid. */
  stepId: string;
  /** Coarse step kind for the trajectory viewer + training format. */
  kind: NormalizedStepKind;
  /** Wall-clock ms from the original event's ISO timestamp. */
  timestamp: number;
  /** Provenance tag, always `"claude-code"` for this module. */
  source: "claude-code";
  /** Source session id from the Claude Code transcript header. */
  sessionId: string;
  /** Parent message uuid in the Claude Code transcript graph. */
  parentUuid: string | null;
  /** Model name from assistant messages (`undefined` for tool results). */
  model?: string;
  /** Anthropic API request id for cross-referencing telemetry. */
  requestId?: string;
  /** Token usage block carried verbatim from the assistant message. */
  usage?: ClaudeCodeUsage;
  /** Reasoning text (kind === "reasoning"). */
  reasoning?: string;
  /** Assistant final-answer text (kind === "text"). */
  text?: string;
  /** Tool call name (kind === "tool_call"). */
  toolName?: string;
  /** Tool call input args (kind === "tool_call"). */
  toolInput?: Record<string, unknown>;
  /** Tool call id linking to the matching tool_result row. */
  toolUseId?: string;
  /** Tool result content (kind === "tool_result"). */
  toolResult?: string;
  /** Whether the tool result was an error (kind === "tool_result"). */
  toolError?: boolean;
}

export interface SessionLogReadResult {
  /** Steps in the original transcript order. Empty when nothing was read. */
  steps: NormalizedTrajectoryStep[];
  /** Absolute path of the JSONL file we parsed, when one was found. */
  sourcePath?: string;
  /** The Claude Code session id pulled from the transcript header. */
  sessionId?: string;
  /** When we returned nothing, why. */
  reason?: "missing" | "empty" | "ok";
  /** Aggregated usage across all assistant turns. */
  totalUsage: ClaudeCodeUsage;
  /** Distinct model ids seen across assistant turns. */
  models: string[];
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Claude Code's per-project log dir encoding. Empirically `/` → `-` and the
 * leading dot of a hidden segment is also `-`, so `/Users/x/.eliza/...`
 * becomes `-Users-x--eliza-...`. Tested against real on-disk samples.
 */
export function encodeClaudeCodeProjectDir(workdir: string): string {
  return workdir.replace(/\//g, "-").replace(/\./g, "-");
}

interface CandidateSessionLogPath {
  /** Directory to scan for `*.jsonl` files. */
  dir: string;
  /** Provenance label for diagnostics. */
  label: "claude-projects" | "workspace-local";
}

export function buildSessionLogCandidates(
  workdir: string,
  home: string = homedir(),
): CandidateSessionLogPath[] {
  const encoded = encodeClaudeCodeProjectDir(workdir);
  return [
    {
      dir: join(home, ".claude", "projects", encoded),
      label: "claude-projects",
    },
    {
      dir: join(workdir, ".claude", "session-logs"),
      label: "workspace-local",
    },
  ];
}

interface SessionLogReaderLogger {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

const NOOP_LOGGER: SessionLogReaderLogger = {};

async function listSessionLogFilesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".jsonl") && !entry.name.endsWith(".json")) {
        continue;
      }
      files.push(join(dir, entry.name));
    }
    return files;
  } catch (err) {
    // ENOENT is the expected "no logs yet" case. Anything else is a real
    // diagnostic the caller's logger should see, but it still falls through
    // to the next candidate.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    return [];
  }
}

interface SessionLogFileEntry {
  filePath: string;
  mtimeMs: number;
}

/**
 * Find the most recently modified session-log file for the given workdir.
 * Returns `null` when no candidate directory exists or no `*.jsonl` /
 * `*.json` files live inside one. Walks both the canonical Claude Code
 * `~/.claude/projects/...` location and the workspace-local fallback.
 */
export async function findClaudeCodeSessionLogFile(
  workdir: string,
  logger: SessionLogReaderLogger = NOOP_LOGGER,
  home: string = homedir(),
): Promise<SessionLogFileEntry | null> {
  const candidates = buildSessionLogCandidates(workdir, home);
  const found: SessionLogFileEntry[] = [];

  for (const candidate of candidates) {
    let files: string[];
    try {
      files = await listSessionLogFilesIn(candidate.dir);
    } catch (err) {
      logger.warn?.(
        `[session-log-reader] failed to read ${candidate.label} dir ${candidate.dir}: ${(err as Error).message}`,
      );
      continue;
    }
    for (const filePath of files) {
      try {
        const info = await stat(filePath);
        found.push({ filePath, mtimeMs: info.mtimeMs });
      } catch (err) {
        logger.warn?.(
          `[session-log-reader] failed to stat ${filePath}: ${(err as Error).message}`,
        );
      }
    }
  }

  if (found.length === 0) return null;
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found[0];
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

function asContentBlockArray(value: unknown): ClaudeCodeContentBlock[] {
  if (!Array.isArray(value)) return [];
  const out: ClaudeCodeContentBlock[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.type !== "string") continue;
    out.push(item as unknown as ClaudeCodeContentBlock);
  }
  return out;
}

function asUsage(value: unknown): ClaudeCodeUsage | undefined {
  if (!isRecord(value)) return undefined;
  const out: ClaudeCodeUsage = {};
  for (const key of [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ] as const) {
    const v = value[key];
    if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isClaudeCodeAssistantEvent(
  event: ClaudeCodeSessionEvent,
): event is ClaudeCodeAssistantEvent {
  if (event.type !== "assistant") return false;
  const message = (event as { message?: unknown }).message;
  return (
    isRecord(message) &&
    message.role === "assistant" &&
    Array.isArray(message.content)
  );
}

function isClaudeCodeUserEvent(
  event: ClaudeCodeSessionEvent,
): event is ClaudeCodeUserEvent {
  if (event.type !== "user") return false;
  const message = (event as { message?: unknown }).message;
  return (
    isRecord(message) &&
    message.role === "user" &&
    (typeof message.content === "string" || Array.isArray(message.content))
  );
}

/**
 * Parse one JSONL line into a typed event. Returns `null` when the line is
 * blank, malformed, or lacks the required `type` field. We don't throw —
 * a single bad line in a long transcript shouldn't drop the whole capture.
 */
export function parseSessionLogLine(
  line: string,
): ClaudeCodeSessionEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!isRecord(raw) || typeof raw.type !== "string") return null;

  if (raw.type === "assistant") {
    if (!isRecord(raw.message)) return null;
    const message = raw.message as Record<string, unknown>;
    if (message.role !== "assistant") return null;
    const assistant: ClaudeCodeAssistantEvent = {
      type: "assistant",
      uuid: asString(raw.uuid) ?? "",
      parentUuid: asNullableString(raw.parentUuid),
      timestamp: asString(raw.timestamp) ?? "",
      sessionId: asString(raw.sessionId) ?? "",
      cwd: asString(raw.cwd),
      requestId: asString(raw.requestId),
      message: {
        role: "assistant",
        id: asString(message.id),
        model: asString(message.model),
        content: asContentBlockArray(message.content),
        stop_reason: asString(message.stop_reason),
        usage: asUsage(message.usage),
      },
    };
    return assistant;
  }

  if (raw.type === "user") {
    if (!isRecord(raw.message)) return null;
    const message = raw.message as Record<string, unknown>;
    if (message.role !== "user") return null;
    const content =
      typeof message.content === "string"
        ? message.content
        : asContentBlockArray(message.content);
    const user: ClaudeCodeUserEvent = {
      type: "user",
      uuid: asString(raw.uuid) ?? "",
      parentUuid: asNullableString(raw.parentUuid),
      timestamp: asString(raw.timestamp) ?? "",
      sessionId: asString(raw.sessionId) ?? "",
      cwd: asString(raw.cwd),
      message: { role: "user", content },
      toolUseResult: raw.toolUseResult,
    };
    return user;
  }

  return raw as ClaudeCodeOtherEvent;
}

/**
 * Parse the full session log file at `filePath`. Returns the typed event
 * list. Malformed lines are dropped with a logger warning; an entirely
 * unreadable file returns an empty array (the caller decides whether to
 * treat that as an error).
 */
export async function parseSessionLogFile(
  filePath: string,
  logger: SessionLogReaderLogger = NOOP_LOGGER,
): Promise<ClaudeCodeSessionEvent[]> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    logger.warn?.(
      `[session-log-reader] failed to read ${filePath}: ${(err as Error).message}`,
    );
    return [];
  }
  const lines = raw.split(/\r?\n/);
  const events: ClaudeCodeSessionEvent[] = [];
  let droppedLines = 0;
  for (const line of lines) {
    const parsed = parseSessionLogLine(line);
    if (parsed) {
      events.push(parsed);
    } else if (line.trim().length > 0) {
      droppedLines += 1;
    }
  }
  if (droppedLines > 0) {
    logger.debug?.(
      `[session-log-reader] ${filePath}: dropped ${droppedLines} malformed lines`,
    );
  }
  return events;
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function flattenToolResultContent(
  content: ClaudeCodeToolResultBlock["content"],
): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const item of content) {
    if (item.type === "text" && typeof item.text === "string") {
      parts.push(item.text);
    }
  }
  return parts.join("\n");
}

function makeChildStepId(
  parentStepId: string,
  uuid: string,
  idx: number,
): string {
  // Compose a stable, parent-scoped child id. Keeping the parent step prefix
  // makes it easy to grep + group child rows back to the parent in BI tools.
  const suffix = uuid && uuid.length > 0 ? uuid.slice(0, 12) : `n${idx}`;
  return `${parentStepId}-cc-${idx.toString().padStart(4, "0")}-${suffix}`;
}

/**
 * Normalize a parsed session log into trajectory step records. Reasoning
 * blocks become their own steps so the trainer can target them. Tool calls
 * carry both name + structured input. Tool results are kept as a separate
 * row (rather than being folded into the call) so the timeline still
 * matches the original transcript order.
 */
export function normalizeSessionEvents(
  events: ClaudeCodeSessionEvent[],
  parentStepId: string,
): NormalizedTrajectoryStep[] {
  const out: NormalizedTrajectoryStep[] = [];
  let idx = 0;

  for (const event of events) {
    if (isClaudeCodeAssistantEvent(event)) {
      const ts = parseTimestamp(event.timestamp);
      const model = event.message.model;
      const usage = event.message.usage;
      for (const block of event.message.content) {
        if (block.type === "thinking") {
          const reasoning = block.thinking;
          if (typeof reasoning !== "string") continue;
          out.push({
            stepId: makeChildStepId(parentStepId, event.uuid, idx),
            kind: "reasoning",
            timestamp: ts,
            source: "claude-code",
            sessionId: event.sessionId,
            parentUuid: event.parentUuid,
            model,
            requestId: event.requestId,
            usage,
            reasoning,
          });
          idx += 1;
        } else if (block.type === "text") {
          out.push({
            stepId: makeChildStepId(parentStepId, event.uuid, idx),
            kind: "text",
            timestamp: ts,
            source: "claude-code",
            sessionId: event.sessionId,
            parentUuid: event.parentUuid,
            model,
            requestId: event.requestId,
            usage,
            text: block.text,
          });
          idx += 1;
        } else if (block.type === "tool_use") {
          out.push({
            stepId: makeChildStepId(parentStepId, event.uuid, idx),
            kind: "tool_call",
            timestamp: ts,
            source: "claude-code",
            sessionId: event.sessionId,
            parentUuid: event.parentUuid,
            model,
            requestId: event.requestId,
            usage,
            toolName: block.name,
            toolInput: block.input ?? {},
            toolUseId: block.id,
          });
          idx += 1;
        }
      }
      continue;
    }

    if (isClaudeCodeUserEvent(event)) {
      const ts = parseTimestamp(event.timestamp);
      const content = event.message.content;
      if (typeof content === "string") continue;
      for (const block of content) {
        if (block.type === "tool_result") {
          out.push({
            stepId: makeChildStepId(parentStepId, event.uuid, idx),
            kind: "tool_result",
            timestamp: ts,
            source: "claude-code",
            sessionId: event.sessionId,
            parentUuid: event.parentUuid,
            toolUseId: block.tool_use_id,
            toolResult: flattenToolResultContent(block.content),
            toolError: block.is_error === true,
          });
          idx += 1;
        }
      }
    }
  }

  return out;
}

function aggregateUsage(events: ClaudeCodeSessionEvent[]): ClaudeCodeUsage {
  const total: ClaudeCodeUsage = {};
  for (const event of events) {
    if (!isClaudeCodeAssistantEvent(event)) continue;
    const usage = event.message.usage;
    if (!usage) continue;
    if (typeof usage.input_tokens === "number") {
      total.input_tokens = (total.input_tokens ?? 0) + usage.input_tokens;
    }
    if (typeof usage.output_tokens === "number") {
      total.output_tokens = (total.output_tokens ?? 0) + usage.output_tokens;
    }
    if (typeof usage.cache_read_input_tokens === "number") {
      total.cache_read_input_tokens =
        (total.cache_read_input_tokens ?? 0) + usage.cache_read_input_tokens;
    }
    if (typeof usage.cache_creation_input_tokens === "number") {
      total.cache_creation_input_tokens =
        (total.cache_creation_input_tokens ?? 0) +
        usage.cache_creation_input_tokens;
    }
  }
  return total;
}

function distinctModels(steps: NormalizedTrajectoryStep[]): string[] {
  const seen = new Set<string>();
  for (const step of steps) {
    if (step.model && !seen.has(step.model)) seen.add(step.model);
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// High-level reader (the entry point the PTY hook calls)
// ---------------------------------------------------------------------------

export interface ReadClaudeCodeSessionOptions {
  /** Working directory the PTY session ran in. */
  workspaceDir: string;
  /** Parent trajectory step id to anchor the merged child steps to. */
  parentStepId: string;
  /** Override `$HOME` resolution; used by tests. */
  home?: string;
  /** Optional logger for diagnostic warnings. */
  logger?: SessionLogReaderLogger;
  /** Optional explicit file path (skips directory discovery). */
  explicitFilePath?: string;
}

/**
 * Locate, parse, and normalize a Claude Code session log into trajectory
 * steps anchored under `parentStepId`. Idempotent — call as many times as
 * you like; the parsed file isn't mutated.
 */
export async function readClaudeCodeSession(
  options: ReadClaudeCodeSessionOptions,
): Promise<SessionLogReadResult> {
  const {
    workspaceDir,
    parentStepId,
    home,
    logger = NOOP_LOGGER,
    explicitFilePath,
  } = options;

  let filePath: string | undefined = explicitFilePath;
  if (!filePath) {
    const located = await findClaudeCodeSessionLogFile(
      workspaceDir,
      logger,
      home,
    );
    filePath = located?.filePath;
  }

  if (!filePath) {
    return {
      steps: [],
      reason: "missing",
      totalUsage: {},
      models: [],
    };
  }

  const events = await parseSessionLogFile(filePath, logger);
  if (events.length === 0) {
    return {
      steps: [],
      sourcePath: filePath,
      reason: "empty",
      totalUsage: {},
      models: [],
    };
  }

  const steps = normalizeSessionEvents(events, parentStepId);
  // Pull sessionId from the first event that carries one — typically the
  // first user message of the transcript.
  let sessionId: string | undefined;
  for (const event of events) {
    const candidate = (event as { sessionId?: string }).sessionId;
    if (typeof candidate === "string" && candidate.length > 0) {
      sessionId = candidate;
      break;
    }
  }

  return {
    steps,
    sourcePath: filePath,
    sessionId,
    reason: steps.length > 0 ? "ok" : "empty",
    totalUsage: aggregateUsage(events),
    models: distinctModels(steps),
  };
}
