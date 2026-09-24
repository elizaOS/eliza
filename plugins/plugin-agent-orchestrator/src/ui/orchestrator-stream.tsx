/**
 * Renders normalized task conversation blocks, including agent-addressable
 * tool and reasoning disclosures shared by Orchestrator and Cockpit views.
 */

import { Badge, Button, Card, Separator } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  Check,
  ChevronRight,
  CircleX,
  FilePen,
  FilePlus,
  FileText,
  Globe,
  Loader,
  type LucideIcon,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { DiffStat, DiffView } from "./orchestrator-diff";
import { countDiff, lineDiff } from "./orchestrator-diff.helpers";
import { MarkdownText } from "./orchestrator-markdown";
import { ReasoningCell } from "./orchestrator-reasoning";
import type {
  ConversationBlock,
  ToolStatus,
  ToolView,
} from "./orchestrator-stream.helpers";
import { formatClockTime, formatDuration } from "./view-format";

export type {
  ConversationBlock,
  ToolView,
} from "./orchestrator-stream.helpers";

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
  failed: { icon: CircleX, tone: "text-destructive", label: "Failed" },
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
export function ToolBody({ tool }: { tool: ToolView }): ReactNode {
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
      <Card key="out" asChild variant="codeFrame">
        <pre
          className="overflow-auto px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-muted"
          style={{ maxHeight: "14rem" }}
        >
          {clampOutput(tool.output)}
        </pre>
      </Card>,
    );
  }

  if (blocks.length === 0) return null;
  return <div className="mt-1.5 space-y-1.5">{blocks}</div>;
}

function ToolCallCard({
  tool,
  onInspect,
}: {
  tool: ToolView;
  onInspect?: () => void;
}): ReactNode {
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
  const toggle = () => {
    onInspect?.();
    setOpen((value) => !value);
  };
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `orchestrator-tool-${tool.groupKey}`,
    role: "toggle",
    label: `${toolVerb(tool)} ${target ?? tool.title}`,
    group: "orchestrator-transcript",
    description: "Show or hide this tool call's details",
    status: open ? "open" : "closed",
    clickable: hasBody,
    onActivate: hasBody ? toggle : undefined,
  });
  return (
    <Card asChild variant="panel">
      <div data-testid="orchestrator-tool-call">
        <Button
          ref={ref}
          variant="sectionToggle"
          size="content"
          align="start"
          type="button"
          disabled={!hasBody}
          onClick={toggle}
          className="disabled:cursor-default"
          {...agentProps}
        >
          {hasBody ? (
            <ChevronRight
              className={`size-3 shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`}
            />
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <Icon className="size-3.5 shrink-0 text-muted-strong" />
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
              className={`size-3 ${badge.spin ? "animate-spin" : ""}`}
            />
            {badge.label}
          </span>
          {meta.length > 0 ? (
            <span className="shrink-0 font-mono text-2xs tabular-nums text-muted/70">
              {meta.join(" · ")}
            </span>
          ) : null}
        </Button>
        {open ? (
          <div className="px-2.5 pb-2">{<ToolBody tool={tool} />}</div>
        ) : null}
      </div>
    </Card>
  );
}

export function ConversationBlockView({
  block,
  locale,
  onInspect,
}: {
  block: ConversationBlock;
  locale?: string;
  onInspect?: () => void;
}): ReactNode {
  if (block.kind === "user") {
    return (
      <div
        className="flex flex-col items-end"
        data-testid="orchestrator-user-message"
      >
        <Card asChild variant="insetCompact">
          <div className="text-xs text-txt" style={{ maxWidth: "80%" }}>
            <div className="whitespace-pre-wrap break-words leading-relaxed">
              {block.content}
            </div>
            <div className="mt-1 text-3xs tabular-nums text-muted/70">
              {formatClockTime(block.at, locale)}
            </div>
          </div>
        </Card>
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
          <Badge asChild variant="mutedDot">
            <span className="inline-block size-1.5" aria-hidden />
          </Badge>
          <span className="font-semibold tracking-tight text-txt/90">
            {block.senderName}
          </span>
          <span className="tabular-nums">
            {formatClockTime(block.at, locale)}
          </span>
        </div>
        <Card asChild variant="transparentSquare">
          <div
            className={
              block.tone === "error"
                ? "w-full pl-2.5 text-destructive"
                : "w-full text-txt"
            }
          >
            <MarkdownText text={block.content} />
          </div>
        </Card>
      </div>
    );
  }

  if (block.kind === "tool") {
    return <ToolCallCard tool={block.tool} onInspect={onInspect} />;
  }

  if (block.kind === "reasoning") {
    return (
      <ReasoningCell
        agentId={`orchestrator-reasoning-${block.key}`}
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
      <Separator className="flex-1" tone="subtle40" />
      <Icon className={`size-3 shrink-0 ${block.tone}`} />
      <span className={`min-w-0 shrink truncate font-medium ${block.tone}`}>
        {block.text}
      </span>
      <Separator className="flex-1" tone="subtle40" />
    </div>
  );
}
