// Pure transform layer for the orchestrator conversation stream, split out of
// orchestrator-stream.tsx so that file exports only React components and stays
// Fast-Refresh-compatible. Turns the polled message + event records into the
// ordered ConversationBlock list the room renders; the .tsx render half consumes
// the exported types (ToolView, ConversationBlock) and buildConversation.
import type {
  CodingAgentTaskEventRecord,
  CodingAgentTaskMessageRecord,
} from "@elizaos/ui";
import {
  Check,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleStop,
  CircleX,
  type LucideIcon,
  OctagonX,
} from "lucide-react";
import { stripAnsi } from "./view-format";

export type ToolStatus = "running" | "done" | "failed";

export interface ToolView {
  /** Session-scoped render key; raw tool ids are not globally unique. */
  groupKey: string;
  /** The tool call's raw id from the adapter, preserved for inspection. */
  id: string;
  /** Task event ids merged into this rendered tool call. */
  eventIds: string[];
  sessionId: string | null;
  /** The tool's own name, e.g. `write`, `bash`, `read`. */
  title: string;
  /** ACP tool kind, e.g. `edit`, `execute`, `read`, `search`. */
  kind: string;
  /** The raw adapter status, before UI normalization. */
  rawStatus?: string;
  /** The raw adapter input payload, preserved for operator inspection. */
  rawInput?: Record<string, unknown>;
  /** The raw adapter output payload, preserved for operator inspection. */
  rawOutput?: unknown;
  status: ToolStatus;
  /** Edited/read file, relative to the session workdir when resolvable. */
  filePath?: string;
  /** Shell command for `execute` tools. */
  command?: string;
  /** New file content (write) or replacement text (edit). */
  newText?: string;
  /** Prior text for an edit, enabling a real +/- diff. */
  oldText?: string;
  /** Query/pattern for search-style tools. */
  query?: string;
  /** Tool result/output, ANSI-stripped. */
  output?: string;
  /** Process exit code for `execute` tools (0 = success); null/undefined when
   * the tool is not an exec invocation or is still running. */
  exitCode?: number | null;
  /** Wall-clock duration in ms from the tool's first to last event. */
  durationMs?: number;
}

export type ConversationBlock =
  | {
      kind: "user";
      key: string;
      at: number;
      content: string;
      messageIds: string[];
      sessionId: string | null;
    }
  | {
      kind: "agent";
      key: string;
      at: number;
      senderName: string;
      content: string;
      tone: "normal" | "error";
      messageIds: string[];
      sessionId: string | null;
    }
  | { kind: "tool"; key: string; at: number; tool: ToolView }
  | {
      kind: "reasoning";
      key: string;
      at: number;
      text: string;
      eventIds: string[];
      sessionId: string | null;
      /** Wall-clock span from the first to the last reasoning delta in the
       * coalesced burst; drives the "Thought for Ns" header. */
      durationMs?: number;
      /** True while the owning session is still running, so reasoning may still
       * be arriving — drives the "Thinking…" header and shimmer. */
      streaming?: boolean;
    }
  | {
      kind: "notice";
      key: string;
      at: number;
      eventId: string;
      eventType: string;
      sessionId: string | null;
      icon: LucideIcon;
      tone: string;
      text: string;
    };

/** Events whose content is already shown elsewhere (prose lives in the message
 * stream; token usage lives in the inspector) and so would only add noise to
 * the conversation. */
const NOISE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message",
  "usage_update",
  "ready",
  "available_commands_update",
]);

interface NoticeMeta {
  icon: LucideIcon;
  tone: string;
  label: string;
}

const NOTICE_META: Record<string, NoticeMeta> = {
  task_registered: { icon: Circle, tone: "text-muted", label: "Task started" },
  task_complete: { icon: CircleCheck, tone: "text-ok", label: "Completed" },
  stopped: { icon: CircleStop, tone: "text-muted", label: "Stopped" },
  blocked: { icon: OctagonX, tone: "text-muted-strong", label: "Blocked" },
  blocked_auto_resolved: {
    icon: Check,
    tone: "text-muted",
    label: "Auto-resolved",
  },
  escalation: { icon: CircleAlert, tone: "text-muted", label: "Escalation" },
  error: { icon: CircleX, tone: "text-red-500", label: "Error" },
};

function noticeMeta(eventType: string): NoticeMeta {
  return (
    NOTICE_META[eventType] ?? {
      icon: Circle,
      tone: "text-muted",
      label: eventType.replace(/_/g, " "),
    }
  );
}

const TOOL_STATUS_FROM_RAW: Record<string, ToolStatus> = {
  in_progress: "running",
  pending: "running",
  running: "running",
  queued: "running",
  completed: "done",
  success: "done",
  done: "done",
  ok: "done",
  failed: "failed",
  error: "failed",
  cancelled: "failed",
  skipped: "failed",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** First non-empty string among `keys` on `obj`. */
function pickString(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/** First finite number among `keys` on `obj`. */
function pickNumber(
  obj: Record<string, unknown> | undefined,
  ...keys: string[]
): number | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Tool output arrives as a possibly JSON-encoded string (e.g. `"\"\""` for an
 * empty result); decode one layer, strip ANSI, and drop if empty. */
function normalizeOutput(value: unknown): string | undefined {
  let text: string | undefined;
  if (typeof value === "string") text = value;
  else if (Array.isArray(value)) {
    text = value
      .map((part) => pickString(asRecord(part), "text", "content") ?? "")
      .join("");
  }
  if (text === undefined) return undefined;
  if (
    text.length >= 2 &&
    text.startsWith('"') &&
    text.endsWith('"') &&
    !text.includes("\n")
  ) {
    try {
      const decoded = JSON.parse(text);
      if (typeof decoded === "string") text = decoded;
    } catch {
      // keep the raw text
    }
  }
  const clean = stripAnsi(text).trim();
  return clean === "" ? undefined : clean;
}

interface ToolOutput {
  text?: string;
  diff?: { path?: string; oldText?: string; newText?: string };
  exitCode?: number;
}

/** ACP tool results arrive as a JSON-encoded array of content blocks, e.g.
 * `[{type:"content",content:{type:"text",text}}, {type:"diff",path,oldText,newText}]`.
 * Pull out the human-readable text and any file diff so the card renders real
 * prose + a diff instead of dumping the raw JSON the agent returned. Plain
 * (non-block) strings fall back to {@link normalizeOutput}. */
function parseToolOutput(raw: unknown): ToolOutput {
  let value = raw;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
      return { text: normalizeOutput(raw) };
    }
    try {
      value = JSON.parse(trimmed);
    } catch {
      return { text: normalizeOutput(raw) };
    }
  }
  const blocks = Array.isArray(value) ? value : [value];
  const texts: string[] = [];
  let diff: ToolOutput["diff"];
  let parsedExitCode: number | undefined;
  for (const block of blocks) {
    const record = asRecord(block);
    if (!record) continue;
    if (record.type === "diff") {
      diff = {
        path: pickString(record, "path"),
        oldText:
          typeof record.oldText === "string" ? record.oldText : undefined,
        newText:
          typeof record.newText === "string" ? record.newText : undefined,
      };
      continue;
    }
    const inner = asRecord(record.content) ?? record;
    const text =
      pickString(inner, "text", "content", "output") ??
      pickString(record, "text", "output");
    if (text) texts.push(text);
    const metadata = asRecord(record.metadata) ?? asRecord(inner.metadata);
    const exitCode =
      pickNumber(metadata, "exitCode", "exit_code") ??
      pickNumber(record, "exitCode", "exit_code") ??
      pickNumber(inner, "exitCode", "exit_code");
    if (exitCode !== undefined) parsedExitCode = exitCode;
  }
  const joined = stripAnsi(texts.join("\n")).trim();
  return {
    text: joined === "" ? undefined : joined,
    diff,
    exitCode: parsedExitCode,
  };
}

/** The raw `data.toolCall` object the ACP service forwards (see its field
 * mapping). Kept as an open record because adapters vary in which fields they
 * populate (`title`/`name`, `rawInput`/`input`, `output`/`rawOutput`, …); every
 * field is read defensively via {@link pickString} / {@link asRecord}. */
function rawToolCall(
  event: CodingAgentTaskEventRecord,
): Record<string, unknown> | undefined {
  return asRecord(event.data?.toolCall);
}

/** Merge the ordered `tool_running` events for one call into a single view:
 * inputs from whichever event carried them, the latest status, and the latest
 * non-empty output. */
function toToolView(
  id: string,
  groupKey: string,
  events: CodingAgentTaskEventRecord[],
): ToolView {
  let title = "tool";
  let kind = "";
  let status: ToolStatus = "running";
  let rawStatus: string | undefined;
  let rawInput: Record<string, unknown> | undefined;
  let rawOutput: unknown;
  let output: string | undefined;
  let outputDiff: ToolOutput["diff"];
  let exitCode: number | undefined;
  for (const event of events) {
    const call = rawToolCall(event);
    if (!call) continue;
    title = pickString(call, "title", "name", "toolName") ?? title;
    kind = pickString(call, "kind") ?? kind;
    const nextRawStatus = pickString(call, "status");
    if (nextRawStatus) {
      rawStatus = nextRawStatus;
      status = TOOL_STATUS_FROM_RAW[nextRawStatus] ?? status;
    }
    const nextInput = asRecord(call.rawInput) ?? asRecord(call.input);
    if (nextInput) rawInput = { ...rawInput, ...nextInput };
    const nextRawOutput = call.output ?? call.rawOutput;
    if (nextRawOutput !== undefined) rawOutput = nextRawOutput;
    const parsed = parseToolOutput(nextRawOutput);
    if (parsed.text) output = parsed.text;
    if (
      parsed.diff?.oldText !== undefined ||
      parsed.diff?.newText !== undefined
    )
      outputDiff = parsed.diff;
    if (parsed.exitCode !== undefined) exitCode = parsed.exitCode;
    const nextExit =
      pickNumber(asRecord(call.exitStatus), "exitCode") ??
      pickNumber(call, "exitCode");
    if (nextExit !== undefined) exitCode = nextExit;
  }
  // A finished exec tool's exit code is the authoritative status — opencode tops
  // its tool events out at in_progress, so the code is what distinguishes a
  // success from a failure.
  if (typeof exitCode === "number") status = exitCode === 0 ? "done" : "failed";
  // Wall-clock span from the tool's first to last event.
  const durationMs =
    events.length > 1
      ? events[events.length - 1].timestamp - events[0].timestamp
      : undefined;
  return {
    groupKey,
    id,
    eventIds: events.map((event) => event.id),
    sessionId: events[0]?.sessionId ?? null,
    title,
    kind,
    rawStatus,
    rawInput,
    rawOutput,
    status,
    filePath: pickString(rawInput, "filePath", "file_path", "path"),
    command: pickString(rawInput, "command", "cmd", "script"),
    // A pure insertion (`old_string:""`), deletion-only edit (`new_string:""`),
    // or empty-file write (`content:""`) is a real change whose "" must survive
    // — pickString drops empty strings, so check the content keys directly and
    // only fall back to it (then the output diff) for the rest.
    newText:
      typeof rawInput?.content === "string"
        ? rawInput.content
        : typeof rawInput?.new_string === "string"
          ? rawInput.new_string
          : typeof rawInput?.newString === "string"
            ? rawInput.newString
            : (pickString(rawInput, "newText") ?? outputDiff?.newText),
    oldText:
      typeof rawInput?.old_string === "string"
        ? rawInput.old_string
        : typeof rawInput?.oldString === "string"
          ? rawInput.oldString
          : (pickString(rawInput, "oldText") ?? outputDiff?.oldText),
    query: pickString(rawInput, "pattern", "query", "regex", "glob"),
    output,
    exitCode,
    durationMs: durationMs && durationMs > 0 ? durationMs : undefined,
  };
}

type Atom =
  | {
      at: number;
      order: number;
      type: "message";
      message: CodingAgentTaskMessageRecord;
    }
  | { at: number; order: number; type: "tool"; tool: ToolView }
  | {
      at: number;
      order: number;
      type: "reasoning";
      eventId: string;
      text: string;
      sessionId: string | null;
    }
  | {
      at: number;
      order: number;
      type: "notice";
      eventId: string;
      sessionId: string | null;
      eventType: string;
      summary: string;
    };

/** The lane an agent/user message coalesces into; messages in the same lane that
 * are adjacent in time merge into one turn. `stderr` stays in its own lane so
 * error output never blends into normal prose. */
function messageLane(message: CodingAgentTaskMessageRecord): string {
  // Each user message is its own turn: key on the id (not a shared "user"
  // lane) so consecutive user messages don't coalesce into one run-on bubble
  // under a single (wrong) shared timestamp.
  if (message.senderKind === "user") return `user:${message.id}`;
  const stream = message.direction === "stderr" ? "err" : "out";
  // Fall back to the message id, not a shared empty string, so unrelated
  // session-less output never coalesces into one rendered turn.
  return `${message.senderKind}:${message.sessionId ?? message.id}:${stream}`;
}

function toolGroupKey(
  event: CodingAgentTaskEventRecord,
  toolCallId: string,
): string {
  return `${event.sessionId ?? event.threadId ?? "sessionless"}:${toolCallId}`;
}

/** Turn the polled message + event records into the ordered conversation the
 * room renders. */
export function buildConversation(
  messages: CodingAgentTaskMessageRecord[],
  events: CodingAgentTaskEventRecord[],
  resolveSenderName: (message: CodingAgentTaskMessageRecord) => string,
  finishedSessionIds: ReadonlySet<string>,
): ConversationBlock[] {
  const toolEvents = new Map<
    string,
    { id: string; events: CodingAgentTaskEventRecord[] }
  >();
  const toolFirstSeen = new Map<string, number>();
  const atoms: Atom[] = [];
  let order = 0;

  for (const message of messages) {
    // Skip raw stdin/keystroke echoes from sub-agents, but ALWAYS render the
    // user's own typed messages — those are recorded with senderKind "user"
    // AND direction "stdin", and skipping them hid the user's input entirely.
    if (
      message.senderKind !== "user" &&
      (message.direction === "stdin" || message.direction === "keys")
    )
      continue;
    if (stripAnsi(message.content).trim() === "") continue;
    atoms.push({
      at: message.timestamp,
      order: order++,
      type: "message",
      message,
    });
  }

  for (const event of events) {
    const call = rawToolCall(event);
    if (call) {
      const id =
        pickString(call, "id", "toolCallId", "callId") ?? `tool-${event.id}`;
      const groupKey = toolGroupKey(event, id);
      const group = toolEvents.get(groupKey);
      if (group) group.events.push(event);
      else {
        toolEvents.set(groupKey, { id, events: [event] });
        toolFirstSeen.set(groupKey, event.timestamp);
      }
      continue;
    }
    // Reasoning streams as many small `agent_thought_chunk` deltas; capture the
    // full text from event.data (not the 160-char summary) and let the block
    // pass coalesce consecutive deltas into one collapsible cell — rendering
    // each delta as its own notice would flood the room.
    if (event.eventType === "reasoning") {
      const text = typeof event.data?.text === "string" ? event.data.text : "";
      if (text)
        atoms.push({
          at: event.timestamp,
          order: order++,
          type: "reasoning",
          eventId: event.id,
          text,
          sessionId: event.sessionId,
        });
      continue;
    }
    if (NOISE_EVENT_TYPES.has(event.eventType)) continue;
    atoms.push({
      at: event.timestamp,
      order: order++,
      type: "notice",
      eventId: event.id,
      sessionId: event.sessionId,
      eventType: event.eventType,
      summary: event.summary,
    });
  }

  for (const [groupKey, group] of toolEvents) {
    const list = group.events;
    const tool = toToolView(group.id, groupKey, list);
    // opencode never persists a tool's terminal status — its events top out at
    // `in_progress`. Once the owning session has finished, a still-"running"
    // tool has in fact completed, so reflect that instead of a perpetual spinner.
    const sessionId = list[0].sessionId;
    if (
      tool.status === "running" &&
      sessionId &&
      finishedSessionIds.has(sessionId)
    ) {
      tool.status = "done";
    }
    atoms.push({
      at: toolFirstSeen.get(groupKey) ?? list[0].timestamp,
      order: order++,
      type: "tool",
      tool,
    });
  }

  atoms.sort((a, b) => a.at - b.at || a.order - b.order);

  const blocks: ConversationBlock[] = [];
  let openLane: {
    lane: string;
    block: Extract<ConversationBlock, { kind: "user" | "agent" }>;
  } | null = null;
  // Consecutive reasoning deltas coalesce into one collapsible cell, the way a
  // message lane coalesces; any non-reasoning atom closes the burst.
  let openReasoning: Extract<ConversationBlock, { kind: "reasoning" }> | null =
    null;

  for (const atom of atoms) {
    if (atom.type === "message") {
      openReasoning = null;
      const lane = messageLane(atom.message);
      const text = stripAnsi(atom.message.content);
      if (openLane && openLane.lane === lane) {
        openLane.block.content += text;
        openLane.block.messageIds.push(atom.message.id);
        continue;
      }
      if (atom.message.senderKind === "user") {
        const block: ConversationBlock = {
          kind: "user",
          key: `msg-${atom.message.id}`,
          at: atom.at,
          content: text,
          messageIds: [atom.message.id],
          sessionId: atom.message.sessionId,
        };
        blocks.push(block);
        openLane = { lane, block };
      } else {
        const block: ConversationBlock = {
          kind: "agent",
          key: `msg-${atom.message.id}`,
          at: atom.at,
          senderName: resolveSenderName(atom.message),
          content: text,
          tone: atom.message.direction === "stderr" ? "error" : "normal",
          messageIds: [atom.message.id],
          sessionId: atom.message.sessionId,
        };
        blocks.push(block);
        openLane = { lane, block };
      }
      continue;
    }
    openLane = null;
    if (atom.type === "reasoning") {
      // Reasoning is still arriving as long as its owning session has not
      // finished; a session-less burst can never be marked finished, so it is
      // treated as settled (its last delta is its end).
      const streaming = atom.sessionId
        ? !finishedSessionIds.has(atom.sessionId)
        : false;
      if (openReasoning && openReasoning.sessionId === atom.sessionId) {
        openReasoning.text += atom.text;
        openReasoning.eventIds.push(atom.eventId);
        // Span = last delta's time − the burst's first; recomputed as deltas
        // append so it always reflects the full burst.
        openReasoning.durationMs = atom.at - openReasoning.at;
        openReasoning.streaming = streaming;
      } else {
        const block = {
          kind: "reasoning" as const,
          key: `reason-${atom.eventId}`,
          at: atom.at,
          text: atom.text,
          eventIds: [atom.eventId],
          sessionId: atom.sessionId,
          // A single-delta burst has no span yet; left undefined so the header
          // reads "Thought" rather than "Thought for 0s".
          durationMs: undefined,
          streaming,
        };
        blocks.push(block);
        openReasoning = block;
      }
      continue;
    }
    openReasoning = null;
    if (atom.type === "tool") {
      blocks.push({
        kind: "tool",
        key: `tool-${atom.tool.groupKey}`,
        at: atom.at,
        tool: atom.tool,
      });
    } else {
      const meta = noticeMeta(atom.eventType);
      blocks.push({
        kind: "notice",
        key: `evt-${atom.eventId}`,
        at: atom.at,
        eventId: atom.eventId,
        eventType: atom.eventType,
        sessionId: atom.sessionId,
        icon: meta.icon,
        tone: meta.tone,
        text: atom.summary.trim() || meta.label,
      });
    }
  }

  return blocks;
}
