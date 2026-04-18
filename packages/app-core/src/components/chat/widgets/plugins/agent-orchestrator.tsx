import { CodingAgentTasksPanel as AppCodingAgentTasksPanel } from "@elizaos/app-task-coordinator";
import { Badge, Button } from "@elizaos/ui";
import {
  Activity,
  AlertTriangle,
  Eye,
  EyeOff,
  Play,
  SquareArrowOutUpRight,
  Trash2,
} from "lucide-react";
import { startTransition, useEffect, useMemo, useState } from "react";
import { client } from "../../../../api";
import type { AppRunSummary } from "../../../../api/client-types-cloud";
import type { ActivityEvent } from "../../../../hooks/useActivityEvents";
import { useApp } from "../../../../state";
import { getRunAttentionReasons } from "../../../apps/run-attention";
import { EmptyWidgetState, WidgetSection } from "../shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "../types";

function relativeTime(ts: number): string {
  const delta = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  const mins = Math.floor(delta / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  task_registered: "bg-ok/20 text-ok",
  task_complete: "bg-ok/20 text-ok",
  stopped: "bg-muted/20 text-muted",
  tool_running: "bg-accent/20 text-accent",
  blocked: "bg-warn/20 text-warn",
  blocked_auto_resolved: "bg-ok/20 text-ok",
  escalation: "bg-warn/20 text-warn",
  error: "bg-danger/20 text-danger",
  "proactive-message": "bg-accent/20 text-accent",
  reminder: "bg-warn/20 text-warn",
  workflow: "bg-ok/20 text-ok",
  "check-in": "bg-accent/20 text-accent",
  nudge: "bg-accent/20 text-accent",
};

const fallbackTranslate = (
  key: string,
  vars?: { defaultValue?: string },
): string => vars?.defaultValue ?? key;

function formatIsoTime(value?: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return relativeTime(date.getTime());
}

function ActivityItemsContent({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <EmptyWidgetState
        icon={<Activity className="h-8 w-8" />}
        title="No recent activity"
      />
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {events.map((event) => (
        <div
          key={event.id}
          className="flex items-start gap-2 rounded px-2 py-1.5 transition-colors hover:bg-bg-hover/50"
        >
          <span className="mt-0.5 w-12 shrink-0 whitespace-nowrap text-2xs text-muted">
            {relativeTime(event.timestamp)}
          </span>
          <Badge
            variant="secondary"
            className={`h-4 shrink-0 px-1.5 py-0 text-3xs ${
              EVENT_TYPE_COLORS[event.eventType] ?? ""
            }`}
          >
            {event.eventType.replace(/_/g, " ")}
          </Badge>
          <span className="min-w-0 flex-1 break-words text-xs-tight text-txt">
            {event.summary}
          </span>
        </div>
      ))}
    </div>
  );
}

function getClientErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function AppRunCard({
  run,
  attentionReasons,
}: {
  run: AppRunSummary;
  attentionReasons: string[];
}) {
  const healthDot =
    run.health.state === "healthy"
      ? "bg-ok"
      : run.health.state === "degraded"
        ? "bg-warn"
        : "bg-danger";
  const ViewerIcon = run.viewerAttachment === "attached" ? Eye : EyeOff;

  return (
    <div className="rounded-lg border border-border/50 bg-bg-accent/30 p-2">
      <div className="min-w-0 flex-1">
        <div className="truncate text-2xs font-semibold text-txt">
          {run.displayName}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-3xs text-muted">
          <span
            className={`inline-block h-1.5 w-1.5 rounded-full ${healthDot}`}
            aria-label={run.health.state}
            title={run.health.state}
          />
          <ViewerIcon
            className="h-3 w-3"
            aria-label={run.viewerAttachment}
          />
          <span>{formatIsoTime(run.lastHeartbeatAt ?? run.updatedAt)}</span>
        </div>
      </div>
      <div className="mt-1 line-clamp-2 text-3xs text-muted">
        {run.summary || run.health.message || "Run active."}
      </div>
      {attentionReasons.length > 0 ? (
        <div className="mt-1.5 flex items-center gap-1.5 text-3xs text-warn">
          <AlertTriangle className="h-3 w-3 shrink-0" aria-label="Needs attention" />
          <span className="truncate">{attentionReasons[0]}</span>
        </div>
      ) : null}
    </div>
  );
}

function AppRunsWidget(_props: ChatSidebarWidgetProps) {
  const app = useApp() as ReturnType<typeof useApp> | undefined;
  const appRuns = app?.appRuns;
  const setState = app?.setState ?? (() => undefined);
  const t = app?.t ?? fallbackTranslate;
  const [runs, setRuns] = useState<AppRunSummary[]>(() =>
    Array.isArray(appRuns) ? appRuns : [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const currentRun =
    runs.find((run) => run.viewerAttachment === "attached" && run.viewer) ??
    null;
  const attachedCount = runs.filter(
    (run) => run.viewerAttachment === "attached",
  ).length;
  const backgroundCount = runs.filter(
    (run) => run.viewerAttachment !== "attached",
  ).length;
  const attentionMap = useMemo(
    () =>
      new Map(
        runs.map((run) => [run.runId, getRunAttentionReasons(run)] as const),
      ),
    [runs],
  );
  const needsAttentionCount = useMemo(
    () =>
      runs.filter((run) => (attentionMap.get(run.runId)?.length ?? 0) > 0)
        .length,
    [attentionMap, runs],
  );
  const attentionRuns = runs.filter(
    (run) => (attentionMap.get(run.runId)?.length ?? 0) > 0,
  );
  const shouldHideWidget = !loading && runs.length === 0 && error === null;

  useEffect(() => {
    let cancelled = false;

    const refreshRuns = async () => {
      try {
        const nextRuns = await client.listAppRuns();
        const nextRunsSafe = Array.isArray(nextRuns) ? nextRuns : [];
        if (cancelled) return;
        setError(null);
        startTransition(() => {
          setRuns(nextRunsSafe);
          setState("appRuns", nextRunsSafe);
        });
      } catch (refreshError) {
        if (cancelled) return;
        setError(
          getClientErrorMessage(refreshError, "Failed to load app runs."),
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void refreshRuns();
    const timer = setInterval(() => {
      void refreshRuns();
    }, 5_000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [setState]);

  if (shouldHideWidget) {
    return null;
  }

  return (
    <WidgetSection
      title={t("appsview.Running", { defaultValue: "Apps" })}
      icon={<Activity className="h-4 w-4" />}
      action={
        <div className="flex items-center gap-1">
          {currentRun ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              aria-label="Resume viewer"
              onClick={() => {
                setState("appRuns", runs);
                setState("activeGameRunId", currentRun.runId);
                setState("tab", "apps");
                setState("appsSubTab", "games");
              }}
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            aria-label="Open apps"
            onClick={() => {
              setState("appRuns", runs);
              setState("tab", "apps");
              setState("appsSubTab", "running");
            }}
          >
            <SquareArrowOutUpRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      }
      testId="chat-widget-app-runs"
    >
      {error ? (
        <div className="mb-2 rounded-md border border-danger/30 bg-danger/10 px-2 py-1.5 text-xs-tight text-danger">
          {error}
        </div>
      ) : null}
      {runs.length === 0 ? (
        loading ? (
          <div className="text-xs-tight text-muted">Loading app runs...</div>
        ) : (
          <EmptyWidgetState
            icon={<Activity className="h-8 w-8" />}
            title="No games are running"
          />
        )
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3 text-3xs text-muted">
            <span
              className="inline-flex items-center gap-1"
              title="Currently playing"
            >
              <Eye className="h-3 w-3" />
              {attachedCount}
            </span>
            <span
              className="inline-flex items-center gap-1"
              title="Background"
            >
              <EyeOff className="h-3 w-3" />
              {backgroundCount}
            </span>
            <span
              className={`inline-flex items-center gap-1 ${
                needsAttentionCount > 0 ? "text-warn" : "text-ok"
              }`}
              title="Needs attention"
            >
              <AlertTriangle className="h-3 w-3" />
              {needsAttentionCount}
            </span>
          </div>
          {attentionRuns.length > 0 ? (
            <div className="rounded-lg border border-warn/30 bg-warn/10 p-2">
              <div className="mb-1.5 flex items-center gap-1.5 text-3xs font-semibold uppercase tracking-[0.08em] text-warn">
                <AlertTriangle className="h-3 w-3" />
                Recovery
              </div>
              <div className="flex flex-col gap-2">
                {attentionRuns.slice(0, 3).map((run) => {
                  const reasons = attentionMap.get(run.runId) ?? [];
                  return (
                    <AppRunCard
                      key={run.runId}
                      run={run}
                      attentionReasons={reasons}
                    />
                  );
                })}
              </div>
            </div>
          ) : null}
          <div className="flex flex-col gap-2">
            {runs.slice(0, 4).map((run) => (
              <AppRunCard
                key={run.runId}
                run={run}
                attentionReasons={attentionMap.get(run.runId) ?? []}
              />
            ))}
          </div>
        </div>
      )}
    </WidgetSection>
  );
}

function OrchestratorTasksWidget(_props: ChatSidebarWidgetProps) {
  return <AppCodingAgentTasksPanel />;
}

function OrchestratorActivityWidget({
  events,
  clearEvents,
}: ChatSidebarWidgetProps) {
  const app = useApp() as ReturnType<typeof useApp> | undefined;
  const t = app?.t ?? fallbackTranslate;

  if (events.length === 0) {
    return null;
  }

  return (
    <WidgetSection
      title={t("taskseventspanel.Activity", { defaultValue: "Activity" })}
      icon={<Activity className="h-4 w-4" />}
      action={
        <Button
          variant="ghost"
          size="sm"
          onClick={clearEvents}
          className="h-6 px-2 text-xs text-muted"
        >
          Clear
        </Button>
      }
      testId="chat-widget-events"
    >
      <ActivityItemsContent events={events} />
    </WidgetSection>
  );
}

export const AGENT_ORCHESTRATOR_PLUGIN_WIDGETS: ChatSidebarWidgetDefinition[] =
  [
    {
      id: "agent-orchestrator.apps",
      pluginId: "agent-orchestrator",
      order: 150,
      defaultEnabled: true,
      Component: AppRunsWidget,
    },
    {
      id: "agent-orchestrator.tasks",
      pluginId: "agent-orchestrator",
      order: 200,
      defaultEnabled: true,
      Component: OrchestratorTasksWidget,
    },
    {
      id: "agent-orchestrator.activity",
      pluginId: "agent-orchestrator",
      order: 300,
      defaultEnabled: true,
      Component: OrchestratorActivityWidget,
    },
  ];
