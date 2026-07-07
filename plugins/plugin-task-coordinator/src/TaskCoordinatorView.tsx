/**
 * TaskCoordinatorView — the GUI data wrapper for the Task Coordinator surface.
 *
 * It owns the live coding-agent task data (the searchable thread list on a 5s
 * poll, the open thread's detail, and the archive/reopen mutations) and renders
 * the one presentational {@link TaskCoordinatorSpatialView} inside a
 * {@link SpatialSurface}.
 *
 * The legacy GUI panel ({@link CodingAgentTasksPanel}) still mounts through the
 * app-core slot registry (the packages/ui Tasks page); this wrapper is the
 * cross-modality view-bundle surface. Each spatial affordance maps 1:1 to a
 * client method.
 */

import {
  ApiError,
  type CodingAgentTaskThread,
  type CodingAgentTaskThreadDetail,
  client,
} from "@elizaos/ui";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type TaskCoordinatorSnapshot,
  TaskCoordinatorSpatialView,
  toTaskCoordinatorRow,
} from "./components/TaskCoordinatorSpatialView.tsx";

const TASK_LIST_LIMIT = 30;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function TaskCoordinatorView() {
  const [threads, setThreads] = useState<CodingAgentTaskThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CodingAgentTaskThreadDetail | null>(
    null,
  );
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refreshThreads = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const next = await client.listCodingAgentTaskThreads({
          includeArchived: showArchived,
          search: search.trim() || undefined,
          limit: TASK_LIST_LIMIT,
        });
        setThreads(next);
        setError(null);
        setSelectedThreadId((current) =>
          current && next.some((t) => t.id === current) ? current : current,
        );
      } catch (err) {
        // The task-thread endpoint is owned by the Node-only orchestrator and is
        // absent on mobile/web surfaces. A 404 there means "no coding tasks",
        // not a load failure — render the empty list instead of an error.
        if (err instanceof ApiError && err.status === 404) {
          setThreads([]);
          setError(null);
          return;
        }
        if (!silent) {
          setError(errorMessage(err));
          setThreads([]);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [showArchived, search],
  );

  const loadDetail = useCallback(async (threadId: string) => {
    try {
      const next = await client.getCodingAgentTaskThread(threadId);
      setDetail(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setDetail(null);
    }
  }, []);

  // Load the thread list on mount + whenever the filters change, then keep it
  // fresh with a quiet 5s poll.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    autoLoadedRef.current = true;
    void refreshThreads(false);
    const interval = setInterval(() => {
      void refreshThreads(true);
      if (selectedThreadId) void loadDetail(selectedThreadId);
    }, 5_000);
    return () => clearInterval(interval);
  }, [refreshThreads, loadDetail, selectedThreadId]);

  // Load the open thread's detail whenever the selection changes.
  useEffect(() => {
    if (!selectedThreadId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedThreadId);
  }, [selectedThreadId, loadDetail]);

  const runMutation = useCallback(
    async (mutate: () => Promise<unknown>) => {
      try {
        await mutate();
        setSelectedThreadId(null);
        await refreshThreads(true);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [refreshThreads],
  );

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("open:")) {
        setSelectedThreadId(action.slice("open:".length));
        return;
      }
      if (action.startsWith("search:")) {
        setSearch(action.slice("search:".length));
        return;
      }
      switch (action) {
        case "toggle-archived":
          setShowArchived((value) => !value);
          return;
        case "refresh":
          void refreshThreads(false);
          return;
        case "back":
          setSelectedThreadId(null);
          return;
        case "delete-thread":
          if (selectedThreadId) {
            void runMutation(() =>
              client.archiveCodingAgentTaskThread(selectedThreadId),
            );
          }
          return;
        case "reopen-thread":
          if (selectedThreadId) {
            setShowArchived(false);
            void runMutation(() =>
              client.reopenCodingAgentTaskThread(selectedThreadId),
            );
          }
          return;
      }
    },
    [refreshThreads, runMutation, selectedThreadId],
  );

  const snapshot: TaskCoordinatorSnapshot = {
    threads: threads.map(toTaskCoordinatorRow),
    selectedThreadId,
    detail,
    showArchived,
    search,
    loading,
    error,
  };

  return (
    <div
      data-testid="task-coordinator-panel"
      style={{
        display: "flex",
        flexDirection: "column",
        width: "100%",
        height: "100%",
        minHeight: 0,
        minWidth: 0,
      }}
    >
      <TaskCoordinatorSpatialView snapshot={snapshot} onAction={onAction} />
    </div>
  );
}
