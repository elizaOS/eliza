/**
 * useOrchestratorData — the orchestrator workbench's live-data layer (#9960).
 *
 * Owns all task/session DATA state (status, tasks, the selected task's detail +
 * timeline) and the fetch / poll / SSE-stream / mutation logic that keeps it
 * live. OrchestratorWorkbench keeps the UI state (selection, filters, drawers)
 * and feeds it in; everything that talks to `client` and holds server data lives
 * here, so the data flow is testable in isolation (use-orchestrator-data.test.ts)
 * without rendering the full workbench view.
 */

import {
  type CodingAgentOrchestratorStatus,
  type CodingAgentTaskEventRecord,
  type CodingAgentTaskMessageRecord,
  type CodingAgentTaskThread,
  type CodingAgentTaskThreadDetail,
  type CodingAgentTaskTimelineItem,
  client,
} from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { TASK_LIST_LIMIT } from "./orchestrator-params";
import type { StatusFilter, Translate } from "./orchestrator-workbench-glyphs";

const TIMELINE_PAGE_LIMIT = 50;
const POLL_INTERVAL_MS = 5_000;
/** While a task has a working agent, poll its room fast so the conversation,
 * tool calls, and tokens stream in near-live instead of lurching every 5s. */
const ACTIVE_POLL_INTERVAL_MS = 1_500;

function getClientErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * True when the connected agent simply doesn't serve the orchestrator backend
 * (a 404 on its routes) — e.g. a local on-device agent without
 * agent-orchestrator. NOT a failure: surface a calm "connect a cloud/desktop
 * agent" hint instead of a red error.
 */
function isOrchestratorBackendAbsent(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (status === 404) return true;
  const msg = error instanceof Error ? error.message.toLowerCase() : "";
  return msg === "not found" || msg.includes("404");
}

/** Merge timeline records by id and return them ascending by timestamp. */
function mergeById<T extends { id: string; timestamp: number }>(
  previous: T[],
  incoming: T[],
): T[] {
  if (incoming.length === 0) return previous;
  const byId = new Map<string, T>();
  for (const item of previous) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function splitTimelineItems(items: CodingAgentTaskTimelineItem[]): {
  messages: CodingAgentTaskMessageRecord[];
  events: CodingAgentTaskEventRecord[];
} {
  const messages: CodingAgentTaskMessageRecord[] = [];
  const events: CodingAgentTaskEventRecord[] = [];
  for (const item of items) {
    if (item.kind === "message") messages.push(item.message);
    else events.push(item.event);
  }
  return { messages, events };
}

export interface UseOrchestratorDataInput {
  /** The currently-selected task id (UI-owned), or null. */
  selectedId: string | null;
  showArchived: boolean;
  statusFilter: StatusFilter;
  /** Debounced search query (already trimmed). */
  deferredSearch: string;
  t: Translate;
}

export interface UseOrchestratorData {
  status: CodingAgentOrchestratorStatus | null;
  tasks: CodingAgentTaskThread[];
  detail: CodingAgentTaskThreadDetail | null;
  messages: CodingAgentTaskMessageRecord[];
  events: CodingAgentTaskEventRecord[];
  timelineCursor: string | null;
  loading: boolean;
  mutating: boolean;
  loadError: string | null;
  backendAbsent: boolean;
  actionError: string | null;
  /** Re-fetch the task list + status (silent = no spinner). */
  refresh: (silent: boolean) => Promise<void>;
  /** Run a write, then reconcile the list + the open task. Surfaces actionError. */
  runMutation: (fn: () => Promise<unknown>) => Promise<void>;
  /** Page in older timeline entries for the open task. */
  loadOlderTimeline: () => Promise<void>;
}

export function useOrchestratorData({
  selectedId,
  showArchived,
  statusFilter,
  deferredSearch,
  t,
}: UseOrchestratorDataInput): UseOrchestratorData {
  const [status, setStatus] = useState<CodingAgentOrchestratorStatus | null>(
    null,
  );
  const [tasks, setTasks] = useState<CodingAgentTaskThread[]>([]);
  const [detail, setDetail] = useState<CodingAgentTaskThreadDetail | null>(
    null,
  );
  const [messages, setMessages] = useState<CodingAgentTaskMessageRecord[]>([]);
  const [events, setEvents] = useState<CodingAgentTaskEventRecord[]>([]);
  const [timelineCursor, setTimelineCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [backendAbsent, setBackendAbsent] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const detailReqRef = useRef(0);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;

  const fetchTasksAndStatus = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const [nextStatus, nextTasks] = await Promise.all([
          client.getOrchestratorStatus(),
          client.listCodingAgentTaskThreads({
            includeArchived: showArchived,
            status: statusFilter === "all" ? undefined : statusFilter,
            search: deferredSearch || undefined,
            limit: TASK_LIST_LIMIT,
          }),
        ]);
        setStatus(nextStatus);
        setTasks(nextTasks);
        setLoadError(null);
        setBackendAbsent(false);
      } catch (error) {
        if (!silent) {
          if (isOrchestratorBackendAbsent(error)) {
            setBackendAbsent(true);
            setLoadError(null);
          } else {
            setBackendAbsent(false);
            setLoadError(
              getClientErrorMessage(
                error,
                t("orchestrator.loadFailed", {
                  defaultValue: "Failed to load orchestrator state.",
                }),
              ),
            );
          }
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [deferredSearch, showArchived, statusFilter, t],
  );

  const fetchDetail = useCallback(async (id: string, reset: boolean) => {
    const token = ++detailReqRef.current;
    const [nextDetail, timelinePage] = await Promise.all([
      client.getCodingAgentTaskThread(id),
      client.listOrchestratorTaskTimeline(id, { limit: TIMELINE_PAGE_LIMIT }),
    ]);
    // Discard if a newer fetch superseded this one, or if the selection moved on
    // while in flight — otherwise a non-reset poll/refresh could merge one task's
    // transcript into another task's room (cross-task contamination).
    if (token !== detailReqRef.current || id !== selectedIdRef.current) return;
    const timeline = splitTimelineItems(timelinePage.items);
    setDetail(nextDetail);
    if (reset) {
      setMessages(mergeById([], timeline.messages));
      setEvents(mergeById([], timeline.events));
      setTimelineCursor(timelinePage.nextCursor);
    } else {
      setMessages((prev) => mergeById(prev, timeline.messages));
      setEvents((prev) => mergeById(prev, timeline.events));
      setTimelineCursor((prev) => prev ?? timelinePage.nextCursor);
    }
  }, []);

  useEffect(() => {
    void fetchTasksAndStatus(false);
    const timer = window.setInterval(
      () => void fetchTasksAndStatus(true),
      POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [fetchTasksAndStatus]);

  const detailPollMs =
    detail !== null &&
    (detail.activeSessionCount > 0 ||
      detail.status === "active" ||
      detail.status === "validating")
      ? ACTIVE_POLL_INTERVAL_MS
      : POLL_INTERVAL_MS;

  useEffect(() => {
    // Load the room whenever the selection changes; clear it when nothing is
    // selected. (The component owns resetting its own transient UI separately.)
    if (!selectedId) {
      setDetail(null);
      setMessages([]);
      setEvents([]);
      setTimelineCursor(null);
      return;
    }
    void fetchDetail(selectedId, true).catch((err: unknown) => {
      console.error("[useOrchestratorData] fetchDetail (initial)", { err });
    });
  }, [selectedId, fetchDetail]);

  useEffect(() => {
    // Reconcile poll — the safety net. The SSE stream below drives near-live
    // updates; this only covers a dropped/absent stream (reconnect fallback).
    if (!selectedId) return;
    const timer = window.setInterval(
      () =>
        void fetchDetail(selectedId, false).catch((err: unknown) => {
          console.error("[useOrchestratorData] fetchDetail (poll)", { err });
        }),
      detailPollMs,
    );
    return () => window.clearInterval(timer);
  }, [selectedId, detailPollMs, fetchDetail]);

  // Coalesce a burst of change pings into one tail refetch per ~150ms window,
  // so live token streaming doesn't trigger a fetch storm.
  const refetchTimerRef = useRef<number | null>(null);
  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current != null) return;
    refetchTimerRef.current = window.setTimeout(() => {
      refetchTimerRef.current = null;
      const current = selectedIdRef.current;
      if (current)
        void fetchDetail(current, false).catch((err: unknown) => {
          console.error("[useOrchestratorData] fetchDetail (debounced)", {
            err,
          });
        });
    }, 150);
  }, [fetchDetail]);

  useEffect(() => {
    // Live push: subscribe to the task's SSE stream; each "change" ping
    // schedules a debounced tail refetch.
    if (!selectedId) return;
    const unsubscribe = client.streamOrchestratorTask(
      selectedId,
      scheduleRefetch,
    );
    return () => {
      unsubscribe();
      if (refetchTimerRef.current != null) {
        window.clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
    };
  }, [selectedId, scheduleRefetch]);

  const runMutation = useCallback(
    async (fn: () => Promise<unknown>) => {
      setMutating(true);
      setActionError(null);
      try {
        await fn();
        await fetchTasksAndStatus(true);
        const current = selectedIdRef.current;
        if (current)
          await fetchDetail(current, false).catch((err: unknown) => {
            console.error("[useOrchestratorData] fetchDetail (mutation)", {
              err,
            });
          });
      } catch (error) {
        setActionError(
          getClientErrorMessage(
            error,
            t("orchestrator.actionFailed", { defaultValue: "Action failed." }),
          ),
        );
      } finally {
        setMutating(false);
      }
    },
    [fetchTasksAndStatus, fetchDetail, t],
  );

  const loadOlderTimeline = useCallback(async () => {
    const current = selectedIdRef.current;
    if (!current || !timelineCursor) return;
    const page = await client.listOrchestratorTaskTimeline(current, {
      cursor: timelineCursor,
      limit: TIMELINE_PAGE_LIMIT,
    });
    // The selection may have moved on during the await — don't merge task A's
    // history into task B (mirrors the fetchDetail guard).
    if (current !== selectedIdRef.current) return;
    const timeline = splitTimelineItems(page.items);
    setMessages((prev) => mergeById(prev, timeline.messages));
    setEvents((prev) => mergeById(prev, timeline.events));
    setTimelineCursor(page.nextCursor);
  }, [timelineCursor]);

  return {
    status,
    tasks,
    detail,
    messages,
    events,
    timelineCursor,
    loading,
    mutating,
    loadError,
    backendAbsent,
    actionError,
    refresh: fetchTasksAndStatus,
    runMutation,
    loadOlderTimeline,
  };
}
