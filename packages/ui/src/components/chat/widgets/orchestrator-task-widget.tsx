/**
 * Live task-progress rail for the orchestrator's compact widget stream. It
 * keeps chat users oriented without duplicating the workbench, and preserves
 * loading, empty, and failure states as visibly different outcomes.
 */

import { AlertTriangle, RefreshCw, Workflow } from "lucide-react";
import { useEffect, useState } from "react";
import { client } from "../../../api";
import "../../../api/client-orchestrator-widgets";
import type {
  OrchestratorWidgetSnapshot,
  OrchestratorWidgetStatus,
  OrchestratorWidgetTask,
} from "../../../api/client-orchestrator-widgets";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { useAppSelectorShallow } from "../../../state";
import type { TranslateFn } from "../../../types";
import { Button } from "../../ui/button";
import { fallbackTranslate } from "./agent-orchestrator-accounts-view";
import { useWidgetNavigation } from "./home-widget-card";
import { EmptyWidgetState, WidgetSection } from "./shared";
import type { ChatSidebarWidgetProps } from "./types";

const STATUS_STYLE: Record<
  OrchestratorWidgetStatus,
  { label: string; className: string }
> = {
  queued: { label: "Queued", className: "bg-muted" },
  running: { label: "Running", className: "bg-accent" },
  needs_input: { label: "Needs input", className: "bg-warn" },
  completed: { label: "Completed", className: "bg-ok" },
  failed: { label: "Failed", className: "bg-danger" },
};

function TaskRow({
  task,
  onOpen,
}: {
  task: OrchestratorWidgetTask;
  onOpen: (taskId: string) => void;
}) {
  const status = STATUS_STYLE[task.status];
  const relationshipCount = task.childTaskIds.length;
  const assignment = [task.model, task.account?.label]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
  return (
    <Button
      variant="ghost"
      className="h-auto w-full min-w-0 justify-start rounded-sm px-2 py-2 text-left hover:bg-bg-hover"
      onClick={() => onOpen(task.taskId)}
      aria-label={`${task.label}. ${status.label}. ${task.progressSummary}. Open in workbench.`}
    >
      <span
        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${status.className}`}
        aria-hidden="true"
      />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs-tight font-medium text-txt">
            {task.label}
          </span>
          <span className="ml-auto shrink-0 text-3xs text-muted">
            {status.label}
          </span>
        </span>
        <span className="mt-0.5 line-clamp-2 block text-3xs leading-relaxed text-muted">
          {task.progressSummary}
        </span>
        {assignment || task.parentTaskId || relationshipCount > 0 ? (
          <span className="mt-1 flex gap-2 text-3xs text-muted">
            {assignment ? <span className="truncate">{assignment}</span> : null}
            {task.parentTaskId || relationshipCount > 0 ? (
              <span className="ml-auto shrink-0">
                {task.parentTaskId ? "Child task" : null}
                {task.parentTaskId && relationshipCount > 0 ? " · " : null}
                {relationshipCount > 0
                  ? `${relationshipCount} child${relationshipCount === 1 ? "" : "ren"}`
                  : null}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </Button>
  );
}

export interface OrchestratorTaskWidgetViewProps {
  snapshot: OrchestratorWidgetSnapshot | null;
  loading: boolean;
  error: string | null;
  t?: TranslateFn;
  onOpenTask: (taskId: string) => void;
  onOpenAll: () => void;
  onRetry: () => void;
}

/** Presentational task rail used by the live container and visual-state stories. */
export function OrchestratorTaskWidgetView({
  snapshot,
  loading,
  error,
  t = fallbackTranslate,
  onOpenTask,
  onOpenAll,
  onRetry,
}: OrchestratorTaskWidgetViewProps) {
  return (
    <WidgetSection
      title={t("agentorchestrator.tasks", { defaultValue: "Tasks" })}
      icon={<Workflow />}
      testId="chat-widget-orchestrator-tasks"
      onTitleClick={onOpenAll}
      action={
        snapshot && snapshot.totalTaskCount > snapshot.tasks.length ? (
          <span className="pr-1 text-3xs text-muted">
            {snapshot.tasks.length} of {snapshot.totalTaskCount}
          </span>
        ) : undefined
      }
    >
      {loading ? (
        <div
          className="space-y-2 py-2"
          role="status"
          aria-label="Loading task progress"
        >
          <div className="h-10 animate-pulse rounded-sm bg-bg-hover" />
          <div className="h-10 animate-pulse rounded-sm bg-bg-hover" />
        </div>
      ) : error ? (
        <div
          className="my-2 flex items-start gap-2 rounded-sm bg-danger/10 p-2 text-3xs text-danger"
          role="alert"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 shrink-0 p-0 text-danger hover:bg-danger/15"
            onClick={onRetry}
            aria-label="Retry task progress"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : snapshot?.tasks.length ? (
        <div className="-mx-1 divide-y divide-border/40">
          {snapshot.tasks.map((task) => (
            <TaskRow key={task.taskId} task={task} onOpen={onOpenTask} />
          ))}
        </div>
      ) : (
        <EmptyWidgetState
          icon={<Workflow className="h-5 w-5" />}
          title={t("agentorchestrator.noTasks", {
            defaultValue: "No orchestration tasks yet",
          })}
          description={t("agentorchestrator.noTasksDescription", {
            defaultValue: "New coding tasks will appear here as they run.",
          })}
        />
      )}
    </WidgetSection>
  );
}

export interface OrchestratorTaskWidgetProps
  extends Partial<ChatSidebarWidgetProps> {
  onOpenTask?: (taskId: string) => void;
  onOpenAll?: () => void;
}

export function OrchestratorTaskWidget({
  onOpenTask,
  onOpenAll,
}: OrchestratorTaskWidgetProps) {
  const authenticated = useIsAuthenticated();
  const { t: appT } = useAppSelectorShallow((state) => ({ t: state.t }));
  const t = appT ?? fallbackTranslate;
  const navigation = useWidgetNavigation();
  const [snapshot, setSnapshot] = useState<OrchestratorWidgetSnapshot | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    if (refreshKey > 0) setSnapshot(null);
    setLoading(true);
    setError(null);

    void client
      .getOrchestratorWidgets({ limit: 8 })
      .then((next) => {
        if (!cancelled) {
          setSnapshot(next);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Task progress is unavailable",
          );
          setLoading(false);
        }
      });

    const closeStream = client.streamOrchestratorWidgets(
      { limit: 8 },
      (next) => {
        if (!cancelled) {
          setSnapshot(next);
          setError(null);
          setLoading(false);
        }
      },
      (cause) => {
        if (!cancelled) {
          setError(cause.message);
          setLoading(false);
        }
      },
    );

    return () => {
      cancelled = true;
      closeStream();
    };
  }, [authenticated, refreshKey]);

  if (!authenticated) return null;

  const openTask =
    onOpenTask ??
    ((taskId: string) => {
      navigation.openView(
        `/orchestrator?taskId=${encodeURIComponent(taskId)}`,
        "orchestrator",
      );
    });

  return (
    <OrchestratorTaskWidgetView
      snapshot={snapshot}
      loading={loading}
      error={error}
      t={t}
      onOpenTask={openTask}
      onOpenAll={
        onOpenAll ??
        (() => navigation.openView("/orchestrator", "orchestrator"))
      }
      onRetry={() => setRefreshKey((value) => value + 1)}
    />
  );
}
