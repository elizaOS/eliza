import type {
  CodingAgentTaskEventRecord,
  CodingAgentTaskMessageRecord,
} from "@elizaos/ui";
import {
  Check,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleStop,
  CircleX,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  Loader,
  type LucideIcon,
  OctagonX,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { countDiff, DiffStat, DiffView, lineDiff } from "./orchestrator-diff";
import { MarkdownText } from "./orchestrator-markdown";

export { sanitizeMarkdownUrl } from "./orchestrator-markdown";

import { ReasoningCell } from "./orchestrator-reasoning";
import { formatClockTime, formatDuration, stripAnsi } from "./view-format";

// The orchestrator room renders a coding-agent session the way Claude Code /
// Codex do: a single flowing conversation of (1) the user's prompts, (2) the
// agent's streamed prose, and (3) the tool calls it makes — each tool shown as
// a structured card (file diff, shell command + output, search query) rather
// than as raw stdout. The backend already captures all of this; the work here
// is purely turning its records into that view.
//
// Two backend realities drive the transform in `buildConversation`:
//   • The agent's prose arrives as many tiny `agent_message_chunk` rows (one per
//     token-ish), so consecutive same-sender chunks are concatenated into one
//     turn instead of rendered as dozens of fragment bubbles.
//   • A single tool invocation emits several `tool_running` events (in_progress
//     → completed), so they are merged by session-scoped `toolCall.id` into one
//     card carrying the final status.

type ToolStatus = "running" | "done" | "failed";

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
      pickString(inner, "text", "content") ?? pickString(record, "text");
    if (text) texts.push(text);
  }
  const joined = stripAnsi(texts.join("\n")).trim();
  return { text: joined === "" ? undefined : joined, diff };
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
  let rawInput: Record<string, unknown> | undefined;
  let output: string | undefined;
  let outputDiff: ToolOutput["diff"];
  let exitCode: number | undefined;
  for (const event of events) {
    const call = rawToolCall(event);
    if (!call) continue;
    title = pickString(call, "title", "name", "toolName") ?? title;
    kind = pickString(call, "kind") ?? kind;
    const rawStatus = pickString(call, "status");
    if (rawStatus) status = TOOL_STATUS_FROM_RAW[rawStatus] ?? status;
    const nextInput = asRecord(call.rawInput) ?? asRecord(call.input);
    if (nextInput) rawInput = { ...rawInput, ...nextInput };
    const parsed = parseToolOutput(call.output ?? call.rawOutput);
    if (parsed.text) output = parsed.text;
    if (
      parsed.diff?.oldText !== undefined ||
      parsed.diff?.newText !== undefined
    )
      outputDiff = parsed.diff;
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
  if (message.senderKind === "user") return "user";
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
      if (lane === "user") {
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
      if (openReasoning) {
        openReasoning.text += atom.text;
        // Span = last delta's time − the burst's first; recomputed as deltas
        // append so it always reflects the full burst.
        openReasoning.durationMs = atom.at - openReasoning.at;
        openReasoning.streaming = streaming;
      } else {
        const block = {
          kind: "reasoning" as const,
          key: `reason-${atom.order}`,
          at: atom.at,
          text: atom.text,
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

// --- Conversation block views ----------------------------------------------

const TOOL_ICON_BY_KIND: Record<string, LucideIcon> = {
  edit: FilePen,
  read: FileText,
  execute: Terminal,
  search: Search,
  fetch: Globe,
  move: FilePen,
  delete: FilePen,
  think: Wrench,
};

const TOOL_ICON_BY_TITLE: Record<string, LucideIcon> = {
  write: FilePlus,
  edit: FilePen,
  read: FileText,
  bash: Terminal,
  shell: Terminal,
  grep: Search,
  glob: Search,
  list: Search,
  webfetch: Globe,
  fetch: Globe,
};

function toolIcon(tool: ToolView): LucideIcon {
  return (
    TOOL_ICON_BY_TITLE[tool.title.toLowerCase()] ??
    TOOL_ICON_BY_KIND[tool.kind.toLowerCase()] ??
    Wrench
  );
}

// Codex labels a tool by the ACTION it took, not the raw tool name: "Ran",
// "Read", "Edited", "Searched", not "bash"/"grep". Present tense while the call
// is in flight, past tense once it has settled (the red badge carries failure,
// so a failed run is still "Ran"). Tuple is [running, settled].
const VERB_BY_KIND: Record<string, readonly [string, string]> = {
  execute: ["Running", "Ran"],
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  search: ["Searching", "Searched"],
  fetch: ["Fetching", "Searched web"],
  move: ["Moving", "Moved"],
  delete: ["Deleting", "Deleted"],
  think: ["Thinking", "Thought"],
};

const VERB_BY_TITLE: Record<string, readonly [string, string]> = {
  write: ["Writing", "Wrote"],
  edit: ["Editing", "Edited"],
  read: ["Reading", "Read"],
  bash: ["Running", "Ran"],
  shell: ["Running", "Ran"],
  grep: ["Searching", "Searched"],
  glob: ["Searching", "Searched"],
  list: ["Listing", "Listed"],
  webfetch: ["Fetching", "Searched web"],
  fetch: ["Fetching", "Searched web"],
};

/** The action verb for a tool's header, status-aware. Falls back to the raw
 * tool name for kinds we don't have a verb for, so nothing renders blank. */
function toolVerb(tool: ToolView): string {
  const pair =
    VERB_BY_TITLE[tool.title.toLowerCase()] ??
    VERB_BY_KIND[tool.kind.toLowerCase()];
  if (!pair) return tool.title;
  return tool.status === "running" ? pair[0] : pair[1];
}

/** The shortest meaningful one-liner about what a tool touched, shown in the
 * collapsed header (file name, command, or query). */
function toolTarget(tool: ToolView): string | undefined {
  if (tool.filePath) {
    const parts = tool.filePath.split("/");
    return parts[parts.length - 1] || tool.filePath;
  }
  if (tool.command) return tool.command;
  if (tool.query) return tool.query;
  return undefined;
}

const STATUS_BADGE: Record<
  ToolStatus,
  { icon: LucideIcon; tone: string; label: string; spin?: boolean }
> = {
  running: {
    icon: Loader,
    tone: "text-muted-strong",
    label: "Running",
    spin: true,
  },
  done: { icon: Check, tone: "text-ok", label: "Done" },
  failed: { icon: CircleX, tone: "text-red-500", label: "Failed" },
};

const MAX_BODY_CHARS = 4000;

function clamp(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_BODY_CHARS) return { body: text, truncated: false };
  return { body: text.slice(0, MAX_BODY_CHARS), truncated: true };
}

function TruncatedNote(): ReactNode {
  return (
    <div className="px-1 text-2xs text-muted/70">… (truncated for display)</div>
  );
}

/** Command output's meaningful result — the error, the exit summary, the last
 * failing line — usually lives at the END, so when it's too long keep BOTH
 * ends and elide the middle rather than dropping the tail (a head-only clamp
 * hides exactly the part you opened the card to read). Diffs keep the head-only
 * clamp above; a mid-string marker there would corrupt line alignment. */
function clampOutput(text: string): string {
  if (text.length <= MAX_BODY_CHARS) return text;
  const head = Math.ceil(MAX_BODY_CHARS * 0.6);
  const tail = MAX_BODY_CHARS - head;
  const elided = text.length - head - tail;
  return `${text.slice(0, head).trimEnd()}\n\n… ${elided.toLocaleString()} characters elided …\n\n${text.slice(-tail).trimStart()}`;
}

/** The expandable body of a tool card: an interleaved diff for edits, the new
 * content for writes, the command + output for shells, and the raw output
 * otherwise. */
function ToolBody({ tool }: { tool: ToolView }): ReactNode {
  const blocks: ReactNode[] = [];

  if (tool.oldText !== undefined && tool.newText !== undefined) {
    const before = clamp(tool.oldText);
    const after = clamp(tool.newText);
    blocks.push(
      <DiffView key="diff" oldText={before.body} newText={after.body} />,
    );
    if (before.truncated || after.truncated)
      blocks.push(<TruncatedNote key="diff-trunc" />);
  } else if (tool.newText !== undefined) {
    const { body, truncated } = clamp(tool.newText);
    blocks.push(<DiffView key="content" newText={body} />);
    if (truncated) blocks.push(<TruncatedNote key="content-trunc" />);
  }

  // The command itself is already shown (untruncated on hover) in the card
  // header, so the body carries only its output — no redundant `$` echo.
  if (tool.output) {
    blocks.push(
      <pre
        key="out"
        className="overflow-auto rounded-md border border-border/40 bg-bg/60 px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-muted"
        style={{ maxHeight: "14rem" }}
      >
        {clampOutput(tool.output)}
      </pre>,
    );
  }

  if (blocks.length === 0) return null;
  return <div className="mt-1.5 space-y-1.5">{blocks}</div>;
}

function ToolCallCard({ tool }: { tool: ToolView }): ReactNode {
  const Icon = toolIcon(tool);
  const badge = STATUS_BADGE[tool.status];
  const BadgeIcon = badge.icon;
  const target = toolTarget(tool);
  // The command lives in the header; only a diff/new content or captured
  // output makes the card expandable. A command that printed nothing is a
  // single tidy line — no chevron, no empty body.
  const hasBody = Boolean(tool.newText !== undefined || tool.output);
  // Edit/write magnitude shown on the collapsed header so the reader sees the
  // size of a change without expanding it.
  const diffStat = useMemo(
    () =>
      tool.newText === undefined
        ? null
        : countDiff(lineDiff(tool.oldText ?? "", tool.newText)),
    [tool.oldText, tool.newText],
  );
  // Codex-style result suffix: a non-zero exit code (red badge already conveys
  // failure) and the wall-clock duration, both dim/mono.
  const meta: string[] = [];
  if (typeof tool.exitCode === "number" && tool.exitCode !== 0)
    meta.push(`exit ${tool.exitCode}`);
  // Only surface a duration once it's meaningful. A non-streaming command
  // (e.g. `pip install --quiet`) emits its start and end events within the
  // same tick, so a sub-second event-span is a logging artifact, not a real
  // runtime — showing "1ms" for a multi-second install would be misleading.
  if (tool.durationMs !== undefined && tool.durationMs >= 1000)
    meta.push(formatDuration(tool.durationMs));
  // Open by default while the agent is mid-edit so the change is visible as it
  // streams; collapse finished read/search calls to keep the room scannable.
  const [open, setOpen] = useState(
    () => hasBody && tool.kind !== "read" && tool.kind !== "search",
  );
  return (
    <div
      className="rounded-md border border-border/50 bg-card/50"
      data-testid="orchestrator-tool-call"
    >
      <button
        type="button"
        disabled={!hasBody}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left disabled:cursor-default"
      >
        {hasBody ? (
          <ChevronRight
            className={`h-3 w-3 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
          />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-strong" />
        <span className="shrink-0 text-xs font-semibold text-txt">
          {toolVerb(tool)}
        </span>
        {target && target !== tool.title ? (
          <span
            title={target}
            className="min-w-0 flex-1 truncate font-mono text-2xs text-muted"
          >
            {target}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {diffStat && (diffStat.added > 0 || diffStat.removed > 0) ? (
          <DiffStat added={diffStat.added} removed={diffStat.removed} />
        ) : null}
        <span
          className={`flex shrink-0 items-center gap-1 text-2xs ${badge.tone}`}
        >
          <BadgeIcon
            className={`h-3 w-3 ${badge.spin ? "animate-spin" : ""}`}
          />
          {badge.label}
        </span>
        {meta.length > 0 ? (
          <span className="shrink-0 font-mono text-2xs tabular-nums text-muted/70">
            {meta.join(" · ")}
          </span>
        ) : null}
      </button>
      {open ? (
        <div className="px-2.5 pb-2">{<ToolBody tool={tool} />}</div>
      ) : null}
    </div>
  );
}

export function ConversationBlockView({
  block,
  locale,
}: {
  block: ConversationBlock;
  locale?: string;
}): ReactNode {
  if (block.kind === "user") {
    return (
      <div
        className="flex flex-col items-end"
        data-testid="orchestrator-user-message"
      >
        <div
          className="rounded-lg border border-border/50 bg-surface px-3 py-2 text-xs text-txt"
          style={{ maxWidth: "80%" }}
        >
          <div className="whitespace-pre-wrap break-words leading-relaxed">
            {block.content}
          </div>
          <div className="mt-1 text-3xs tabular-nums text-muted/70">
            {formatClockTime(block.at, locale)}
          </div>
        </div>
      </div>
    );
  }

  if (block.kind === "agent") {
    // Codex Desktop renders the assistant turn FLAT (full-width markdown, no
    // bubble) with a small identity marker — only the user's turn is bubbled.
    return (
      <div
        className="flex w-full flex-col items-start"
        data-testid="orchestrator-agent-message"
      >
        <div className="mb-1 flex items-center gap-2 text-3xs text-muted">
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-muted-strong"
            aria-hidden
          />
          <span className="font-semibold tracking-tight text-txt/90">
            {block.senderName}
          </span>
          <span className="tabular-nums">
            {formatClockTime(block.at, locale)}
          </span>
        </div>
        <div
          className={
            block.tone === "error"
              ? "w-full border-l-2 border-red-500/40 pl-2.5 text-red-500"
              : "w-full text-txt"
          }
        >
          <MarkdownText text={block.content} />
        </div>
      </div>
    );
  }

  if (block.kind === "tool") {
    return <ToolCallCard tool={block.tool} />;
  }

  if (block.kind === "reasoning") {
    return (
      <ReasoningCell
        text={block.text}
        durationMs={block.durationMs}
        streaming={block.streaming}
      />
    );
  }

  const Icon = block.icon;
  return (
    <div
      className="flex items-center gap-2 px-1 text-2xs text-muted"
      data-testid="orchestrator-notice"
    >
      <span className="h-px flex-1 bg-border/40" />
      <Icon className={`h-3 w-3 shrink-0 ${block.tone}`} />
      <span className={`min-w-0 shrink truncate font-medium ${block.tone}`}>
        {block.text}
      </span>
      <span className="h-px flex-1 bg-border/40" />
    </div>
  );
}
