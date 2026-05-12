/**
 * Chat-sidebar widgets for the `agent-orchestrator` plugin (Apps / Tasks /
 * Activity). This file lives in `@elizaos/app-core` (not in
 * `@elizaos/plugin-agent-orchestrator`) because the widget depends on app-core
 * internals that the runtime plugin does not own and does not re-export:
 * the app-core API client, `AppRunSummary` / `ActivityEvent` types, the
 * `useApp` store, `TranslateFn`, `getRunAttentionReasons`, and the widget
 * registry contract (`ChatSidebarWidgetDefinition` / `ChatSidebarWidgetProps`
 * and the `EmptyWidgetState` / `WidgetSection` primitives).
 *
 * The runtime plugin is a pure Node package (actions, providers, services,
 * api, types) with no React build target or widget-publication mechanism.
 * Moving this file into the plugin would require standing up a React build,
 * publishing app-core internals, and adding a widget-registration hook — a
 * reverse coupling we don't want. The widget is owned by the app shell; the
 * plugin just provides the backend capabilities it consumes.
 */

import { Button } from "../../ui/button";
import {
  Activity,
  AlertTriangle,
  BellRing,
  Check,
  CheckCheck,
  Eye,
  EyeOff,
  HeartPulse,
  type LucideIcon,
  MessageSquare,
  OctagonAlert,
  Play,
  Square,
  SquareArrowOutUpRight,
  SquarePause,
  Trash2,
  Workflow,
  Wrench,
  Zap,
} from "lucide-react";
import { startTransition, useEffect, useMemo, useState } from "react";
import { client, type RegistryAppInfo } from "../../../api";
import type { AppRunSummary } from "../../../api/client-types-cloud";
import type { ActivityEvent } from "../../../hooks/useActivityEvents";
import { useApp } from "../../../state";
import type { TranslateFn } from "../../../types";
import { AppHero, type AppIdentitySource } from "../../apps/app-identity";
import { loadMergedCatalogApps } from "../../apps/catalog-loader";
import { getRunAttentionReasons } from "../../apps/run-attention";
import { EmptyWidgetState, WidgetSection } from "./shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "./types";

function relativeTime(ts: number): string {
  const delta = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  const mins = Math.floor(delta / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ago`;
}

function relativeDuration(ts: number): string {
  const delta = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (delta < 60) return `${delta}s`;
  const mins = Math.floor(delta / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

type EventTypeMeta = {
  icon: LucideIcon;
  toneClass: string;
  label: string;
};

const DEFAULT_EVENT_TYPE_META: EventTypeMeta = {
  icon: Activity,
  toneClass: "bg-muted/20 text-muted",
  label: "activity",
};

const EVENT_TYPE_META: Record<string, EventTypeMeta> = {
  task_registered: {
    icon: Play,
    toneClass: "bg-ok/20 text-ok",
    label: "task started",
  },
  task_complete: {
    icon: Check,
    toneClass: "bg-ok/20 text-ok",
    label: "task complete",
  },
  stopped: {
    icon: Square,
    toneClass: "bg-muted/20 text-muted",
    label: "stopped",
  },
  tool_running: {
    icon: Wrench,
    toneClass: "bg-accent/20 text-accent",
    label: "tool running",
  },
  blocked: {
    icon: SquarePause,
    toneClass: "bg-warn/20 text-warn",
    label: "blocked",
  },
  blocked_auto_resolved: {
    icon: CheckCheck,
    toneClass: "bg-ok/20 text-ok",
    label: "auto resolved",
  },
  escalation: {
    icon: AlertTriangle,
    toneClass: "bg-warn/20 text-warn",
    label: "escalation",
  },
  error: {
    icon: OctagonAlert,
    toneClass: "bg-danger/20 text-danger",
    label: "error",
  },
  "proactive-message": {
    icon: MessageSquare,
    toneClass: "bg-accent/20 text-accent",
    label: "proactive message",
  },
  reminder: {
    icon: BellRing,
    toneClass: "bg-warn/20 text-warn",
    label: "reminder",
  },
  workflow: {
    icon: Workflow,
    toneClass: "bg-ok/20 text-ok",
    label: "workflow",
  },
  "check-in": {
    icon: HeartPulse,
    toneClass: "bg-accent/20 text-accent",
    label: "check in",
  },
  nudge: {
    icon: Zap,
    toneClass: "bg-accent/20 text-accent",
    label: "nudge",
  },
};

const fallbackTranslate: TranslateFn = (key, vars) =>
  typeof vars?.defaultValue === "string" ? vars.defaultValue : key;

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
      {events.map((event) => {
        const eventTypeMeta =
          EVENT_TYPE_META[event.eventType] ?? DEFAULT_EVENT_TYPE_META;
        const EventIcon = eventTypeMeta.icon;

        return (
          <div
            key={event.id}
            className="flex items-start gap-1.5 rounded-md px-1.5 py-1 transition-colors hover:bg-bg-hover/40"
          >
            <span className="shrink-0 whitespace-nowrap pt-0.5 text-3xs font-medium tabular-nums text-muted">
              {relativeDuration(event.timestamp)}
            </span>
            <span
              className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-md ${eventTypeMeta.toneClass}`}
              role="img"
              title={eventTypeMeta.label}
            >
              <EventIcon className="h-2.5 w-2.5" />
              <span className="sr-only">{eventTypeMeta.label}</span>
            </span>
            <span className="min-w-0 flex-1 break-words pt-0.5 text-2xs leading-4 text-txt">
              {event.summary}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function getClientErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getAppRunIdentity(
  run: AppRunSummary,
  catalogAppsByName: ReadonlyMap<string, RegistryAppInfo>,
): AppIdentitySource {
  const catalogApp = catalogAppsByName.get(run.appName);

  return {
    name: run.appName,
    displayName: catalogApp?.displayName ?? run.displayName,
    description: catalogApp?.description ?? run.summary ?? null,
    category: catalogApp?.category ?? "utility",
    icon: catalogApp?.icon ?? null,
    heroImage: catalogApp?.heroImage ?? null,
  };
}

function AppRunCard({
  run,
  attentionReasons,
  app,
}: {
  run: AppRunSummary;
  attentionReasons: string[];
  app: AppIdentitySource;
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
      <div className="flex items-start gap-2">
        <div className="w-20 shrink-0 overflow-hidden rounded-md border border-white/10 bg-black/10">
          <AppHero app={app} className="aspect-[5/4]" imageOnly />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-2xs font-semibold text-txt">
            {run.displayName}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-3xs text-muted">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${healthDot}`}
              role="img"
              aria-label={run.health.state}
              title={run.health.state}
            />
            <ViewerIcon className="h-3 w-3" aria-label={run.viewerAttachment} />
            <span>{formatIsoTime(run.lastHeartbeatAt ?? run.updatedAt)}</span>
          </div>
          <div className="mt-1 line-clamp-2 text-3xs text-muted">
            {run.summary || run.health.message || "Run active."}
          </div>
          {attentionReasons.length > 0 ? (
            <div className="mt-1.5 flex items-center gap-1.5 text-3xs text-warn">
              <AlertTriangle
                className="h-3 w-3 shrink-0"
                aria-label="Needs attention"
              />
              <span className="truncate">{attentionReasons[0]}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function AppRunsWidget(_props: ChatSidebarWidgetProps) {
  const app = useApp() as ReturnType<typeof useApp> | undefined;
  const appRuns = app?.appRuns;
  const setTab = app?.setTab ?? (() => undefined);
  const setState = app?.setState ?? (() => undefined);
  const t = app?.t ?? fallbackTranslate;
  const [catalogApps, setCatalogApps] = useState<RegistryAppInfo[]>([]);
  const [runs, setRuns] = useState<AppRunSummary[]>(() =>
    Array.isArray(appRuns) ? appRuns : [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const catalogAppsByName = useMemo(
    () =>
      new Map(catalogApps.map((catalogApp) => [catalogApp.name, catalogApp])),
    [catalogApps],
  );
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

    void loadMergedCatalogApps({ includeHiddenApps: true })
      .then((apps) => {
        if (!cancelled) {
          setCatalogApps(apps);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

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
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              aria-label="Resume viewer"
              onClick={() => {
                setState("appRuns", runs);
                setState("activeGameRunId", currentRun.runId);
                setTab("apps");
                setState("appsSubTab", "games");
              }}
            >
              <Play className="h-3.5 w-3.5" />
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            aria-label="Open apps"
            onClick={() => {
              setState("appRuns", runs);
              setTab("apps");
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
            <span className="inline-flex items-center gap-1" title="Background">
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
                      app={getAppRunIdentity(run, catalogAppsByName)}
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
                app={getAppRunIdentity(run, catalogAppsByName)}
              />
            ))}
          </div>
        </div>
      )}
    </WidgetSection>
  );
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
          aria-label="Clear activity"
          className="h-6 w-6 p-0 text-muted"
        >
          <Trash2 className="h-3.5 w-3.5" />
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
      id: "agent-orchestrator.activity",
      pluginId: "agent-orchestrator",
      order: 300,
      defaultEnabled: true,
      Component: OrchestratorActivityWidget,
    },
  ];
