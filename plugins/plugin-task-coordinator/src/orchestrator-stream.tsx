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
import { type ReactNode, useState } from "react";
import { DiffView } from "./orchestrator-diff";
import { formatClockTime, stripAnsi } from "./view-format";

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
//     → completed), so they are merged by `toolCall.id` into one card carrying
//     the final status.

type ToolStatus = "running" | "done" | "failed";

export interface ToolView {
  id: string;
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
}

export type ConversationBlock =
  | { kind: "user"; key: string; at: number; content: string }
  | {
      kind: "agent";
      key: string;
      at: number;
      senderName: string;
      content: string;
      tone: "normal" | "error";
    }
  | { kind: "tool"; key: string; at: number; tool: ToolView }
  | {
      kind: "notice";
      key: string;
      at: number;
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
  blocked: { icon: OctagonX, tone: "text-warn", label: "Blocked" },
  blocked_auto_resolved: {
    icon: Check,
    tone: "text-muted",
    label: "Auto-resolved",
  },
  escalation: { icon: CircleAlert, tone: "text-warn", label: "Escalation" },
  error: { icon: CircleX, tone: "text-danger", label: "Error" },
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
  events: CodingAgentTaskEventRecord[],
): ToolView {
  let title = "tool";
  let kind = "";
  let status: ToolStatus = "running";
  let rawInput: Record<string, unknown> | undefined;
  let output: string | undefined;
  for (const event of events) {
    const call = rawToolCall(event);
    if (!call) continue;
    title = pickString(call, "title", "name", "toolName") ?? title;
    kind = pickString(call, "kind") ?? kind;
    const rawStatus = pickString(call, "status");
    if (rawStatus) status = TOOL_STATUS_FROM_RAW[rawStatus] ?? status;
    const nextInput = asRecord(call.rawInput) ?? asRecord(call.input);
    if (nextInput) rawInput = { ...rawInput, ...nextInput };
    const nextOutput = normalizeOutput(call.output ?? call.rawOutput);
    if (nextOutput) output = nextOutput;
  }
  return {
    id,
    title,
    kind,
    status,
    filePath: pickString(rawInput, "filePath", "file_path", "path"),
    command: pickString(rawInput, "command", "cmd", "script"),
    newText: pickString(
      rawInput,
      "content",
      "newString",
      "new_string",
      "newText",
    ),
    oldText: pickString(rawInput, "oldString", "old_string", "oldText"),
    query: pickString(rawInput, "pattern", "query", "regex", "glob"),
    output,
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
      type: "notice";
      eventType: string;
      summary: string;
    };

/** The lane an agent/user message coalesces into; messages in the same lane that
 * are adjacent in time merge into one turn. `stderr` stays in its own lane so
 * error output never blends into normal prose. */
function messageLane(message: CodingAgentTaskMessageRecord): string {
  if (message.senderKind === "user") return "user";
  const stream = message.direction === "stderr" ? "err" : "out";
  return `${message.senderKind}:${message.sessionId ?? ""}:${stream}`;
}

/** Turn the polled message + event records into the ordered conversation the
 * room renders. */
export function buildConversation(
  messages: CodingAgentTaskMessageRecord[],
  events: CodingAgentTaskEventRecord[],
  resolveSenderName: (message: CodingAgentTaskMessageRecord) => string,
  finishedSessionIds: ReadonlySet<string>,
): ConversationBlock[] {
  const toolEvents = new Map<string, CodingAgentTaskEventRecord[]>();
  const toolFirstSeen = new Map<string, number>();
  const atoms: Atom[] = [];
  let order = 0;

  for (const message of messages) {
    if (
      (message.direction === "stdin" || message.direction === "keys") &&
      message.senderKind !== "user"
    ) {
      continue;
    }
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
      const list = toolEvents.get(id);
      if (list) list.push(event);
      else {
        toolEvents.set(id, [event]);
        toolFirstSeen.set(id, event.timestamp);
      }
      continue;
    }
    if (NOISE_EVENT_TYPES.has(event.eventType)) continue;
    atoms.push({
      at: event.timestamp,
      order: order++,
      type: "notice",
      eventType: event.eventType,
      summary: event.summary,
    });
  }

  for (const [id, list] of toolEvents) {
    const tool = toToolView(id, list);
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
      at: toolFirstSeen.get(id) ?? list[0].timestamp,
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

  for (const atom of atoms) {
    if (atom.type === "message") {
      const lane = messageLane(atom.message);
      const text = stripAnsi(atom.message.content);
      if (openLane && openLane.lane === lane) {
        openLane.block.content += text;
        continue;
      }
      if (lane === "user") {
        const block: ConversationBlock = {
          kind: "user",
          key: `msg-${atom.message.id}`,
          at: atom.at,
          content: text,
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
        };
        blocks.push(block);
        openLane = { lane, block };
      }
      continue;
    }
    openLane = null;
    if (atom.type === "tool") {
      blocks.push({
        kind: "tool",
        key: `tool-${atom.tool.id}`,
        at: atom.at,
        tool: atom.tool,
      });
    } else {
      const meta = noticeMeta(atom.eventType);
      blocks.push({
        kind: "notice",
        key: `evt-${atom.order}`,
        at: atom.at,
        icon: meta.icon,
        tone: meta.tone,
        text: atom.summary.trim() || meta.label,
      });
    }
  }

  return blocks;
}

// --- Lightweight markdown ---------------------------------------------------
// The agent writes markdown prose; rendering it (code fences, inline code,
// bold, lists, headings) is what makes the room read like a chat rather than a
// log. This is deliberately small — no external markdown engine — matching the
// in-repo precedent (config-field's preview renderer).

const FENCE = /```([\w-]*)\n?([\s\S]*?)```/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let last = 0;
  let index = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      nodes.push(
        <strong key={`${keyBase}-b${index}`} className="font-semibold text-txt">
          {match[1]}
        </strong>,
      );
    } else if (match[2] !== undefined) {
      nodes.push(
        <code
          key={`${keyBase}-c${index}`}
          className="rounded bg-bg/70 px-1 py-px font-mono text-[0.95em] text-accent"
        >
          {match[2]}
        </code>,
      );
    } else if (match[3] !== undefined) {
      nodes.push(
        <a
          key={`${keyBase}-l${index}`}
          href={match[4]}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline underline-offset-2"
        >
          {match[3]}
        </a>,
      );
    }
    last = match.index + match[0].length;
    index += 1;
    match = pattern.exec(text);
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderProse(text: string, keyBase: string): ReactNode {
  const lines = text.split("\n");
  return lines.map((line, lineIndex) => {
    const key = `${keyBase}-${lineIndex}`;
    if (line.trim() === "") return <div key={key} className="h-2" />;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      return (
        <div key={key} className="mt-1 font-semibold text-txt">
          {renderInline(heading[2], key)}
        </div>
      );
    }
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line);
    if (bullet) {
      return (
        <div key={key} className="flex gap-1.5">
          <span className="select-none text-muted">•</span>
          <span className="min-w-0 flex-1">{renderInline(bullet[1], key)}</span>
        </div>
      );
    }
    const numbered = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (numbered) {
      return (
        <div key={key} className="flex gap-1.5">
          <span className="select-none tabular-nums text-muted">
            {numbered[1]}.
          </span>
          <span className="min-w-0 flex-1">
            {renderInline(numbered[2], key)}
          </span>
        </div>
      );
    }
    return (
      <div key={key} className="break-words leading-relaxed">
        {renderInline(line, key)}
      </div>
    );
  });
}

export function MarkdownText({ text }: { text: string }): ReactNode {
  const segments: ReactNode[] = [];
  let last = 0;
  let index = 0;
  FENCE.lastIndex = 0;
  let match = FENCE.exec(text);
  while (match !== null) {
    if (match.index > last) {
      segments.push(
        <div key={`p${index}`}>
          {renderProse(text.slice(last, match.index), `p${index}`)}
        </div>,
      );
    }
    segments.push(
      <CodeBlock
        key={`f${index}`}
        language={match[1]}
        code={match[2].replace(/\n$/, "")}
      />,
    );
    last = match.index + match[0].length;
    index += 1;
    match = FENCE.exec(text);
  }
  if (last < text.length) {
    segments.push(
      <div key={`p${index}`}>{renderProse(text.slice(last), `p${index}`)}</div>,
    );
  }
  return <div className="space-y-0.5">{segments}</div>;
}

function CodeBlock({
  language,
  code,
}: {
  language?: string;
  code: string;
}): ReactNode {
  return (
    <div className="my-1 overflow-hidden rounded-md border border-border/50 bg-bg/80">
      {language ? (
        <div className="border-b border-border/40 px-2 py-0.5 font-mono text-2xs text-muted">
          {language}
        </div>
      ) : null}
      <pre className="max-h-72 overflow-auto px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-txt">
        {code}
      </pre>
    </div>
  );
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
  running: { icon: Loader, tone: "text-accent", label: "Running", spin: true },
  done: { icon: Check, tone: "text-ok", label: "Done" },
  failed: { icon: CircleX, tone: "text-danger", label: "Failed" },
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

  if (tool.command) {
    blocks.push(
      <div
        key="cmd"
        className="rounded-md border border-border/40 bg-black/40 px-2.5 py-1 font-mono text-2xs text-txt"
      >
        <span className="select-none text-ok">$ </span>
        <span className="whitespace-pre-wrap break-words">{tool.command}</span>
      </div>,
    );
  }

  if (tool.output) {
    const { body, truncated } = clamp(tool.output);
    blocks.push(
      <pre
        key="out"
        className="overflow-auto rounded-md border border-border/40 bg-bg/60 px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-muted"
        style={{ maxHeight: "14rem" }}
      >
        {body}
        {truncated ? "\n… (truncated)" : ""}
      </pre>,
    );
  }

  if (blocks.length === 0) return null;
  return <div className="mt-1.5 space-y-1.5">{blocks}</div>;
}

function ToolCallCard({
  tool,
  at,
  locale,
}: {
  tool: ToolView;
  at: number;
  locale?: string;
}): ReactNode {
  const Icon = toolIcon(tool);
  const badge = STATUS_BADGE[tool.status];
  const BadgeIcon = badge.icon;
  const target = toolTarget(tool);
  const hasBody = Boolean(
    tool.newText !== undefined || tool.command || tool.output,
  );
  // Open by default while the agent is mid-edit so the change is visible as it
  // streams; collapse finished read/search calls to keep the room scannable.
  const [open, setOpen] = useState(
    () => hasBody && tool.kind !== "read" && tool.kind !== "search",
  );
  return (
    <div
      className="rounded-md border border-border/50 bg-bg-accent/20"
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
        <Icon className="h-3.5 w-3.5 shrink-0 text-accent" />
        <span className="shrink-0 font-mono text-xs font-semibold text-txt">
          {tool.title}
        </span>
        {target ? (
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted">
            {target}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span
          className={`flex shrink-0 items-center gap-1 text-2xs ${badge.tone}`}
        >
          <BadgeIcon
            className={`h-3 w-3 ${badge.spin ? "animate-spin" : ""}`}
          />
          {badge.label}
        </span>
        <span className="shrink-0 tabular-nums text-2xs text-muted/70">
          {formatClockTime(at, locale)}
        </span>
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
          className="rounded-lg bg-accent/20 px-2.5 py-1.5 text-xs text-txt"
          style={{ maxWidth: "88%" }}
        >
          <div className="mb-0.5 text-2xs tabular-nums text-muted">
            {formatClockTime(block.at, locale)}
          </div>
          <div className="whitespace-pre-wrap break-words">{block.content}</div>
        </div>
      </div>
    );
  }

  if (block.kind === "agent") {
    return (
      <div
        className="flex flex-col items-start"
        data-testid="orchestrator-agent-message"
      >
        <div
          className={`rounded-lg px-2.5 py-1.5 text-xs ${
            block.tone === "error"
              ? "bg-danger/10 text-danger"
              : "bg-bg-hover/60 text-txt"
          }`}
          style={{ maxWidth: "92%" }}
        >
          <div className="mb-0.5 flex items-center gap-2 text-2xs text-muted">
            <span className="font-semibold tracking-tight text-txt/90">
              {block.senderName}
            </span>
            <span className="tabular-nums">
              {formatClockTime(block.at, locale)}
            </span>
          </div>
          <MarkdownText text={block.content} />
        </div>
      </div>
    );
  }

  if (block.kind === "tool") {
    return <ToolCallCard tool={block.tool} at={block.at} locale={locale} />;
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
      <span className="shrink-0 tabular-nums">
        {formatClockTime(block.at, locale)}
      </span>
      <span className="h-px flex-1 bg-border/40" />
    </div>
  );
}
