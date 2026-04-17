import type { AppRunSummary } from "../../../../api/client-types-cloud";
import { CodingAgentTasksPanel as AppCodingAgentTasksPanel } from "@elizaos/app-task-coordinator";
import { Activity } from "lucide-react";
import { startTransition, useEffect, useMemo, useState } from "react";
import { client } from "../../../../api";
import type { ActivityEvent } from "../../../../hooks/useActivityEvents";
import { useApp } from "../../../../state";
import { getRunAttentionReasons } from "../../../apps/run-attention";
import { EmptyWidgetState, WidgetSection } from "../shared";
import { Badge, Button } from "@elizaos/ui";
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
  const healthTone =
    run.health.state === "healthy"
      ? "bg-ok/20 text-ok"
      : run.health.state === "degraded"
        ? "bg-warn/20 text-warn"
        : "bg-danger/20 text-danger";

  return (
    <div className="rounded-lg border border-border/50 bg-bg-accent/30 p-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-txt">
            {run.displayName}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-2xs text-muted">
            <Badge variant="secondary" className={`px-1.5 py-0 ${healthTone}`}>
              {run.health.state}
            </Badge>
            <span>{run.status}</span>
            <span>{run.viewerAttachment}</span>
            <span>{formatIsoTime(run.lastHeartbeatAt ?? run.updatedAt)}</span>
          </div>
        </div>
      </div>
      <div className="mt-2 line-clamp-2 text-xs-tight text-muted">
        {run.summary || run.health.message || "Run active."}
      </div>
      {attentionReasons.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          <Badge
            variant="secondary"
            className="bg-warn/15 px-1.5 py-0 text-3xs text-warn"
          >
            Needs attention
          </Badge>
          <span className="inline-flex max-w-full items-center rounded-full border border-border/30 bg-bg-hover/70 px-2 py-0.5 text-2xs text-muted-strong">
            <span className="truncate">{attentionReasons[0]}</span>
          </span>
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
        <div className="flex items-center gap-1.5">
          {currentRun ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-2xs"
              onClick={() => {
                setState("appRuns", runs);
                setState("activeGameRunId", currentRun.runId);
                setState("tab", "apps");
                setState("appsSubTab", "games");
              }}
            >
              Resume Viewer
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-2xs"
            onClick={() => {
              setState("appRuns", runs);
              setState("tab", "apps");
              setState("appsSubTab", "running");
            }}
          >
            Open Apps
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
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap gap-2 text-2xs text-muted">
            <Badge variant="secondary" className="bg-bg-hover/70 text-muted">
              Currently playing: {attachedCount}
            </Badge>
            <Badge variant="secondary" className="bg-bg-hover/70 text-muted">
              Background: {backgroundCount}
            </Badge>
            <Badge
              variant="secondary"
              className={
                needsAttentionCount > 0
                  ? "bg-warn/15 text-warn"
                  : "bg-ok/15 text-ok"
              }
            >
              Needs attention: {needsAttentionCount}
            </Badge>
          </div>
          {attentionRuns.length > 0 ? (
            <div className="rounded-lg border border-warn/30 bg-warn/10 p-2.5">
              <div className="mb-2 text-2xs font-semibold uppercase tracking-[0.08em] text-warn">
                Recovery queue
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
