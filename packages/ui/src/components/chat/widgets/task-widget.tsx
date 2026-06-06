/**
 * TaskWidget — minimal inline chat widget for an orchestrator task thread.
 *
 * Rendered by `MessageContent` when an assistant message contains a
 * `[TASK:<threadId>]<title>[/TASK]` block (see `../message-task-parser.ts`).
 *
 * Anatomy: one compact card (~64px). Title line on top, structured status
 * line below — status dot + label, agents (active/total), relative last
 * activity, token total. The whole card is a button that navigates to
 * `/orchestrator?taskId=<threadId>` so the workbench can mount its full
 * inspector. Action buttons live in the workbench, not here — this widget
 * exists to surface state, not to compete with the workbench's
 * view-dependent action bar.
 *
 * Live updates are by short polling (5s). When the task is terminal
 * (done/failed/closed/archived) the poll stops and the row freezes. A
 * deleted task (404) renders as muted "Task removed."; we never throw into
 * the chat surface.
 */

import {
  Archive,
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
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../../api/client";
import type { CodingAgentTaskThreadDetail } from "../../../api/client-types-cloud";

/** Mirrors the workbench's poll cadence; one source of truth lives there. */
const POLL_INTERVAL_MS = 5_000;
/**
 * After this many CONSECUTIVE fetch errors we stop polling. A 401/403 from a
 * stale auth token would otherwise hammer the endpoint every 5 seconds for
 * the lifetime of the chat. The widget freezes on the last good state; the
 * user can refresh to retry.
 */
const MAX_CONSECUTIVE_ERRORS = 3;

type Status = CodingAgentTaskThreadDetail["status"];

const TERMINAL_STATUSES: ReadonlySet<Status> = new Set<Status>([
  "done",
  "failed",
  "archived",
]);

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
  if (ts == null) return null;
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

export function TaskWidget({ threadId, fallbackTitle }: TaskWidgetProps) {
  const [detail, setDetail] = useState<CodingAgentTaskThreadDetail | null>(
    null,
  );
  const [removed, setRemoved] = useState(false);
  const [pollingStopped, setPollingStopped] = useState(false);
  const cancelledRef = useRef(false);
  const errorCountRef = useRef(0);

  const fetchDetail = useCallback(async () => {
    try {
      const next = await client.getCodingAgentTaskThread(threadId);
      if (cancelledRef.current) return;
      errorCountRef.current = 0;
      if (next === null) {
        setRemoved(true);
        return;
      }
      setDetail(next);
    } catch {
      // Silent for transient failures, but count consecutive errors so a
      // 401/403 stale-token loop can't poll the endpoint forever. After
      // MAX_CONSECUTIVE_ERRORS we freeze on the last good state.
      if (cancelledRef.current) return;
      errorCountRef.current += 1;
      if (errorCountRef.current >= MAX_CONSECUTIVE_ERRORS) {
        setPollingStopped(true);
      }
    }
  }, [threadId]);

  useEffect(() => {
    cancelledRef.current = false;
    errorCountRef.current = 0;
    void fetchDetail();
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchDetail]);

  useEffect(() => {
    if (removed || pollingStopped) return;
    const status = detail?.status;
    if (status && TERMINAL_STATUSES.has(status)) return;
    const handle = setInterval(() => {
      void fetchDetail();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [detail?.status, fetchDetail, removed, pollingStopped]);

  const handleOpen = useCallback(() => {
    if (typeof window === "undefined") return;
    const detail = { viewPath: `/orchestrator?taskId=${threadId}` };
    window.dispatchEvent(new CustomEvent("eliza:navigate:view", { detail }));
  }, [threadId]);

  if (removed) {
    return (
      <div
        data-testid="task-widget"
        data-task-id={threadId}
        data-removed="true"
        className="my-2 rounded-sm border border-border bg-card px-3 py-2 text-xs text-muted"
      >
        Task removed.
      </div>
    );
  }

  const status: Status = detail?.status ?? "open";
  const StatusIcon = STATUS_ICON[status];
  const title = detail?.title ?? fallbackTitle;
  const sessionCount = detail?.sessionCount ?? 0;
  const activeSessionCount = detail?.activeSessionCount ?? 0;
  const relative = formatRelative(detail?.latestActivityAt ?? null);
  const tokens =
    detail?.usage?.state === "unavailable"
      ? null
      : formatCompactTokens(detail?.usage?.totalTokens ?? null);

  return (
    <button
      type="button"
      data-testid="task-widget"
      data-task-id={threadId}
      data-task-status={status}
      onClick={handleOpen}
      className="my-2 flex w-full items-start gap-2 rounded-sm border border-border bg-card px-3 py-2 text-left transition-colors hover:bg-bg-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
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
    </button>
  );
}
