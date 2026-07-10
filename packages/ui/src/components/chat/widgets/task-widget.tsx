/**
 * TaskWidget — the inline `[TASK:<threadId>]<title>[/TASK]` chat card, upgraded
 * to a live orchestrator pipeline (issue #13536 §(b),(c)).
 *
 * Rendered by `MessageContent` from the `[TASK]` marker (see
 * `../message-task-parser.ts`). The collapsed header shows the task's title +
 * status + agent count; expanding it reveals the running sub-agents nested
 * under it, each with its live current step, tool-call rows, and plan checklist
 * — the Codex/Claude-Code "child session" model.
 *
 * Updates are **stream-driven**: the body reads `useTaskActivity(threadId)`,
 * which regroups the `pty-session-event` WS feed into this task's subtree. There
 * is NO poll. A single hydrate fetch on mount fills the durable header fields
 * (title/status/token total) that predate the current WS session; everything
 * after arrives on the stream. A deleted task (404) renders "Task removed.";
 * we never throw into the chat surface.
 */

import {
  Archive,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePlay,
  CircleX,
  type LucideIcon,
  OctagonX,
  UserRound,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../../api/client";
import type { CodingAgentTaskThreadDetail } from "../../../api/client-types-cloud";
import { dispatchNavigateViewEvent } from "../../../events";
import { useTaskActivity } from "../../../state/task-activity-store";
import { Button } from "../../ui/button";
import { findTaskRegions, type TaskRegion } from "../message-task-parser";
import { registerInlineWidget } from "./inline-registry";
import { PlanChecklist, SubagentBlock } from "./task-pipeline";

type Status = CodingAgentTaskThreadDetail["status"];

const STATUS_ICON: Record<Status, LucideIcon> = {
  open: Circle,
  active: CirclePlay,
  waiting_on_user: UserRound,
  blocked: OctagonX,
  validating: CircleDashed,
  done: CircleCheck,
  failed: CircleX,
  archived: Archive,
  interrupted: CircleAlert,
};

const STATUS_TONE: Record<Status, string> = {
  open: "text-muted",
  active: "text-ok",
  waiting_on_user: "text-warn",
  blocked: "text-warn",
  validating: "text-accent",
  done: "text-ok",
  failed: "text-danger",
  archived: "text-muted",
  interrupted: "text-warn",
};

const STATUS_PULSE: ReadonlySet<Status> = new Set<Status>([
  "active",
  "validating",
]);

const STATUS_LABEL: Record<Status, string> = {
  open: "open",
  active: "active",
  waiting_on_user: "waiting on you",
  blocked: "blocked",
  validating: "validating",
  done: "done",
  failed: "failed",
  archived: "archived",
  interrupted: "interrupted",
};

function formatRelative(ts: number | null | undefined): string | null {
  if (ts == null || ts <= 0) return null;
  const delta = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  const mins = Math.floor(delta / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatCompactTokens(total: number | null | undefined): string | null {
  if (total == null || total <= 0) return null;
  if (total < 1000) return `${total}`;
  if (total < 1_000_000) return `${(total / 1000).toFixed(1)}K`;
  return `${(total / 1_000_000).toFixed(1)}M`;
}

export interface TaskWidgetProps {
  threadId: string;
  fallbackTitle: string;
}

// Memoized on its two primitive props (threadId/fallbackTitle compare `===`):
// the widget is stream-driven from `task-activity-store` internally, so the
// per-token re-parse of the surrounding message must not re-render it. Default
// shallow `memo` is sufficient — both props are strings, never rebuilt objects.
export const TaskWidget = memo(function TaskWidget({
  threadId,
  fallbackTitle,
}: TaskWidgetProps) {
  const [detail, setDetail] = useState<CodingAgentTaskThreadDetail | null>(
    null,
  );
  const [removed, setRemoved] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const cancelledRef = useRef(false);
  const activity = useTaskActivity(threadId);

  // Single durable hydrate — NOT a poll. Fills header fields that predate the
  // current WS session (title/status/token total). Live progress arrives on the
  // stream via `useTaskActivity`.
  const hydrate = useCallback(async () => {
    const next = await client.getCodingAgentTaskThread(threadId).catch(() => {
      // error-policy:J4 hydrate is best-effort — a transient failure leaves the
      // header on its fallback title while the live stream still drives the
      // body. It is a one-shot fetch, not a poll loop, so nothing to back off.
      return undefined;
    });
    if (cancelledRef.current || next === undefined) return;
    if (next === null) setRemoved(true);
    else setDetail(next);
  }, [threadId]);

  useEffect(() => {
    cancelledRef.current = false;
    void hydrate();
    return () => {
      cancelledRef.current = true;
    };
  }, [hydrate]);

  const handleOpenWorkbench = useCallback(() => {
    if (typeof window === "undefined") return;
    dispatchNavigateViewEvent({ viewPath: `/orchestrator?taskId=${threadId}` });
  }, [threadId]);

  if (removed) {
    return (
      <div
        data-testid="task-widget"
        data-task-id={threadId}
        data-removed="true"
        className="my-2 py-1 text-xs text-muted"
      >
        Task removed.
      </div>
    );
  }

  const hasLive = activity.subagents.length > 0;
  const liveActive = activity.subagents.filter(
    (a) => a.status === "running" || a.status === "waiting",
  ).length;

  const status: Status = detail?.status ?? (hasLive ? "active" : "open");
  const StatusIcon = STATUS_ICON[status];
  const title = detail?.title ?? fallbackTitle;
  const sessionCount = hasLive
    ? activity.subagents.length
    : (detail?.sessionCount ?? 0);
  const activeSessionCount = hasLive
    ? liveActive
    : (detail?.activeSessionCount ?? 0);
  const relative = formatRelative(
    activity.updatedAt || detail?.latestActivityAt || null,
  );
  const tokens =
    detail?.usage?.state === "unavailable"
      ? null
      : formatCompactTokens(detail?.usage?.totalTokens ?? null);

  return (
    <div
      data-testid="task-widget"
      data-task-id={threadId}
      data-task-status={status}
      data-expanded={expanded ? "true" : "false"}
      className="my-2 overflow-hidden"
    >
      <Button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        variant="ghost"
        aria-expanded={expanded}
        className="flex h-auto w-full items-start justify-start gap-2 whitespace-normal rounded-sm -mx-2 px-2 py-1.5 text-left font-normal transition-colors hover:bg-bg-hover"
      >
        <span
          className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center ${STATUS_TONE[status]}`}
          role="img"
          aria-label={STATUS_LABEL[status]}
          title={STATUS_LABEL[status]}
        >
          <StatusIcon
            className={`h-3.5 w-3.5 ${
              STATUS_PULSE.has(status) ? "animate-pulse" : ""
            }`}
          />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-txt">
            {title}
          </span>
          <span
            data-testid="task-widget-status"
            className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted"
          >
            <span className={STATUS_TONE[status]}>{STATUS_LABEL[status]}</span>
            {sessionCount > 0 ? (
              <>
                <span className="text-muted/40">·</span>
                <span>
                  {activeSessionCount}/{sessionCount} agents
                </span>
              </>
            ) : null}
            {relative ? (
              <>
                <span className="text-muted/40">·</span>
                <span>{relative}</span>
              </>
            ) : null}
            {tokens ? (
              <>
                <span className="text-muted/40">·</span>
                <span className="tabular-nums">{tokens}</span>
              </>
            ) : null}
          </span>
        </span>
        <ChevronDown
          className={`mt-0.5 h-4 w-4 shrink-0 text-muted transition-transform ${
            expanded ? "rotate-180" : ""
          }`}
        />
      </Button>

      {expanded ? (
        <div
          data-testid="task-widget-pipeline"
          className="flex flex-col gap-3 py-2"
        >
          {activity.plan.length > 0 && activity.subagents.length <= 1 ? (
            <PlanChecklist entries={activity.plan} title="Plan" />
          ) : null}
          {hasLive ? (
            activity.subagents.map((agent) => (
              <SubagentBlock key={agent.sessionId} agent={agent} />
            ))
          ) : (
            <div className="text-xs text-muted">
              Waiting for agent activity…
            </div>
          )}
          <Button
            type="button"
            onClick={handleOpenWorkbench}
            variant="ghost"
            className="h-auto w-fit self-start px-2 py-1 text-xs text-accent hover:text-accent-hover"
          >
            Open in workbench →
          </Button>
        </div>
      ) : null}
    </div>
  );
});

/**
 * Register the `[TASK:<threadId>]…[/TASK]` inline widget into the chat-reply
 * registry. NOT auto-invoked — the orchestrator plugin calls this at boot, so
 * the task widget only renders in chat when the orchestrator UI is loaded.
 */
export function registerTaskWidget(): void {
  registerInlineWidget<TaskRegion>({
    kind: "task",
    parse: (text) => findTaskRegions(text).map((m) => ({ ...m, data: m })),
    keyFor: (m) => `task:${m.threadId}`,
    render: (m, _ctx, key) => (
      <TaskWidget key={key} threadId={m.threadId} fallbackTitle={m.title} />
    ),
  });
}
