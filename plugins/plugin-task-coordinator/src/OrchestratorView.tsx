/**
 * OrchestratorView — the single GUI/XR/TUI data wrapper for the Orchestrator
 * surface.
 *
 * It owns a focused live subset of the workbench's data (orchestrator status +
 * the task-thread page on a 5s poll, plus the open thread's detail) and renders
 * the one presentational {@link OrchestratorSpatialView} inside a
 * {@link SpatialSurface}. Omitting the `modality` prop lets `SpatialSurface`
 * auto-detect GUI vs XR via `window.__elizaXRContext`, so the SAME component
 * serves both surfaces. The TUI surface renders the same `OrchestratorSpatialView`
 * through the terminal registry (see `register-terminal-view.tsx`).
 *
 * The rich GUI route (`/orchestrator`, {@link OrchestratorWorkbench}) keeps the
 * full mutation/SSE/inspector surface — this wrapper is the cross-modality
 * dashboard, not a replacement for it. `onAction` maps each spatial affordance
 * 1:1 to a client method (or, for richer flows like adding an agent, navigates
 * to the workbench).
 */

import {
  type CodingAgentOrchestratorStatus,
  type CodingAgentPendingDecisionRecord,
  type CodingAgentTaskThread,
  type CodingAgentTaskThreadDetail,
  client,
} from "@elizaos/ui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type OrchestratorPlanStep,
  type OrchestratorSnapshot,
  OrchestratorSpatialView,
} from "./components/OrchestratorSpatialView.tsx";

const TASK_LIST_LIMIT = 30;

/** Map the free-form `currentPlan` record into the renderable plan-step shape. */
function derivePlanSteps(
  plan: Record<string, unknown> | null | undefined,
): OrchestratorPlanStep[] {
  if (!plan) return [];
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : [];
  const steps: OrchestratorPlanStep[] = [];
  for (const raw of rawSteps) {
    if (typeof raw === "string" && raw.trim()) {
      steps.push({
        id: `step-${steps.length}`,
        label: raw.trim(),
        state: "pending",
      });
      continue;
    }
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      const label =
        (typeof obj.title === "string" && obj.title) ||
        (typeof obj.label === "string" && obj.label) ||
        (typeof obj.description === "string" && obj.description) ||
        null;
      if (!label) continue;
      const status = typeof obj.status === "string" ? obj.status : "";
      steps.push({
        id: `step-${steps.length}`,
        label,
        state:
          status === "done" || status === "complete" || status === "completed"
            ? "done"
            : status === "active" ||
                status === "in_progress" ||
                status === "running"
              ? "active"
              : status === "blocked" || status === "failed"
                ? "blocked"
                : "pending",
      });
    }
  }
  return steps;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Open the rich Orchestrator workbench route via the navigation bus. */
function openWorkbench(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("eliza:navigate:view", {
      detail: { viewId: "orchestrator", viewPath: "/orchestrator" },
    }),
  );
}

/** Copy a deep link to the open task to the clipboard. */
function copyTaskLink(taskId: string): void {
  if (typeof window === "undefined") return;
  const url = `${window.location.origin}/orchestrator?task=${encodeURIComponent(taskId)}`;
  void navigator.clipboard?.writeText(url).catch(() => {
    // Clipboard access is best-effort; a denied permission is not an error
    // worth surfacing in the dashboard.
  });
}

export function OrchestratorView() {
  const [status, setStatus] =
    useState<CodingAgentOrchestratorStatus | null>(null);
  const [threads, setThreads] = useState<CodingAgentTaskThread[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CodingAgentTaskThreadDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshList = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [nextStatus, nextThreads] = await Promise.all([
          client.getOrchestratorStatus(),
          client.listCodingAgentTaskThreads({ limit: TASK_LIST_LIMIT }),
        ]);
        setStatus(nextStatus);
        setThreads(nextThreads);
        setHasMore(nextThreads.length >= TASK_LIST_LIMIT);
        setError(null);
      } catch (err) {
        if (!silent) {
          setError(errorMessage(err));
          setStatus(null);
          setThreads([]);
          setHasMore(false);
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [],
  );

  const loadDetail = useCallback(async (taskId: string) => {
    try {
      const next = await client.getCodingAgentTaskThread(taskId);
      setDetail(next);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
      setDetail(null);
    }
  }, []);

  // Load the task list on mount, then keep it fresh with a quiet 5s poll.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (!autoLoadedRef.current) {
      autoLoadedRef.current = true;
      void refreshList(false);
    }
    const interval = setInterval(() => {
      void refreshList(true);
      if (selectedTaskId) void loadDetail(selectedTaskId);
    }, 5_000);
    return () => clearInterval(interval);
  }, [refreshList, loadDetail, selectedTaskId]);

  // Load the open thread's detail whenever the selection changes.
  useEffect(() => {
    if (!selectedTaskId) {
      setDetail(null);
      return;
    }
    void loadDetail(selectedTaskId);
  }, [selectedTaskId, loadDetail]);

  const runMutation = useCallback(
    async (mutate: () => Promise<unknown>) => {
      try {
        await mutate();
        await refreshList(true);
        if (selectedTaskId) await loadDetail(selectedTaskId);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [refreshList, loadDetail, selectedTaskId],
  );

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("open:")) {
        setSelectedTaskId(action.slice("open:".length));
        return;
      }
      if (action.startsWith("stop-session:")) {
        const sessionId = action.slice("stop-session:".length);
        if (selectedTaskId) {
          void runMutation(() =>
            client.stopOrchestratorAgent(selectedTaskId, sessionId),
          );
        }
        return;
      }
      if (action.startsWith("priority:")) {
        const priority = action.slice("priority:".length);
        if (
          selectedTaskId &&
          (priority === "low" ||
            priority === "normal" ||
            priority === "high" ||
            priority === "urgent")
        ) {
          void runMutation(() =>
            client.updateOrchestratorTask(selectedTaskId, { priority }),
          );
        }
        return;
      }
      switch (action) {
        case "refresh":
          void refreshList(false);
          return;
        case "pause-all":
          void runMutation(() => client.pauseAllOrchestratorTasks());
          return;
        case "resume-all":
          void runMutation(() => client.resumeAllOrchestratorTasks());
          return;
        case "back":
          setSelectedTaskId(null);
          return;
        case "add-agent":
          openWorkbench();
          return;
      }
      if (!selectedTaskId) return;
      switch (action) {
        case "pause":
          void runMutation(() => client.pauseOrchestratorTask(selectedTaskId));
          return;
        case "resume":
          void runMutation(() => client.resumeOrchestratorTask(selectedTaskId));
          return;
        case "validate":
          void runMutation(() =>
            client.validateOrchestratorTask(selectedTaskId, { passed: true }),
          );
          return;
        case "fork":
          void runMutation(() => client.forkOrchestratorTask(selectedTaskId));
          return;
        case "restart":
          void runMutation(() =>
            client.restartOrchestratorTask(selectedTaskId),
          );
          return;
        case "delete":
          void runMutation(async () => {
            await client.deleteOrchestratorTask(selectedTaskId);
            setSelectedTaskId(null);
          });
          return;
        case "archive":
          void runMutation(async () => {
            await client.archiveCodingAgentTaskThread(selectedTaskId);
            setSelectedTaskId(null);
          });
          return;
        case "reopen":
          void runMutation(() =>
            client.reopenCodingAgentTaskThread(selectedTaskId),
          );
          return;
        case "copy-link":
          copyTaskLink(selectedTaskId);
          return;
      }
    },
    [refreshList, runMutation, selectedTaskId],
  );

  const pendingInputs: CodingAgentPendingDecisionRecord[] =
    detail?.pendingDecisions ?? [];

  const snapshot: OrchestratorSnapshot = {
    status,
    threads,
    hasMore,
    detail,
    planSteps: detail ? derivePlanSteps(detail.currentPlan) : [],
    pendingInputs,
    loading,
    error,
  };

  return (
    <SpatialSurface>
      <OrchestratorSpatialView snapshot={snapshot} onAction={onAction} />
    </SpatialSurface>
  );
}
