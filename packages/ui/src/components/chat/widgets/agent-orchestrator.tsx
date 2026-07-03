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
import {
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { client, type RegistryAppInfo } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
import type { AccountsListResponse } from "../../../api/client-agent";
import type {
  AppRunSummary,
  OrchestratorAccountOverview,
  OrchestratorRoomRosterOverview,
} from "../../../api/client-types-cloud";
import type { ActivityEvent } from "../../../hooks/useActivityEvents";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { useIntervalWhenDocumentVisible } from "../../../hooks/useDocumentVisibility";
import { useAppSelectorShallow } from "../../../state";
import type { TranslateFn } from "../../../types";
import { AppHero, type AppIdentitySource } from "../../apps/app-identity";
import { loadMergedCatalogApps } from "../../apps/catalog-loader";
import { getRunAttentionReasons } from "../../apps/run-attention";
import { Button } from "../../ui/button";
import {
  fallbackTranslate,
  OrchestratorAccountsView,
} from "./agent-orchestrator-accounts-view";
import { OrchestratorRoomView } from "./agent-orchestrator-room-view";
import { HomeWidgetCard, useWidgetNavigation } from "./home-widget-card";
import { EmptyWidgetState, WidgetSection } from "./shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "./types";

function relativeTime(ts: number, t: TranslateFn): string {
  const delta = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (delta < 5)
    return t("agentorchestrator.justNow", { defaultValue: "just now" });
  if (delta < 60)
    return t("agentorchestrator.secondsAgo", {
      count: delta,
      defaultValue: "{{count}}s ago",
    });
  const mins = Math.floor(delta / 60);
  if (mins < 60)
    return t("agentorchestrator.minutesAgo", {
      count: mins,
      defaultValue: "{{count}}m ago",
    });
  const hrs = Math.floor(mins / 60);
  return t("agentorchestrator.hoursAgo", {
    count: hrs,
    defaultValue: "{{count}}h ago",
  });
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
  labelKey: string;
  defaultLabel: string;
};

const DEFAULT_EVENT_TYPE_META: EventTypeMeta = {
  icon: Activity,
  toneClass: "bg-muted/20 text-muted",
  labelKey: "agentorchestrator.eventActivity",
  defaultLabel: "activity",
};

const EVENT_TYPE_META: Record<string, EventTypeMeta> = {
  task_registered: {
    icon: Play,
    toneClass: "bg-ok/20 text-ok",
    labelKey: "agentorchestrator.eventTaskStarted",
    defaultLabel: "task started",
  },
  task_complete: {
    icon: Check,
    toneClass: "bg-ok/20 text-ok",
    labelKey: "agentorchestrator.eventTaskComplete",
    defaultLabel: "task complete",
  },
  stopped: {
    icon: Square,
    toneClass: "bg-muted/20 text-muted",
    labelKey: "agentorchestrator.eventStopped",
    defaultLabel: "stopped",
  },
  tool_running: {
    icon: Wrench,
    toneClass: "bg-accent/20 text-accent",
    labelKey: "agentorchestrator.eventToolRunning",
    defaultLabel: "tool running",
  },
  blocked: {
    icon: SquarePause,
    toneClass: "bg-warn/20 text-warn",
    labelKey: "agentorchestrator.eventBlocked",
    defaultLabel: "blocked",
  },
  blocked_auto_resolved: {
    icon: CheckCheck,
    toneClass: "bg-ok/20 text-ok",
    labelKey: "agentorchestrator.eventAutoResolved",
    defaultLabel: "auto resolved",
  },
  escalation: {
    icon: AlertTriangle,
    toneClass: "bg-warn/20 text-warn",
    labelKey: "agentorchestrator.eventEscalation",
    defaultLabel: "escalation",
  },
  error: {
    icon: OctagonAlert,
    toneClass: "bg-danger/20 text-danger",
    labelKey: "agentorchestrator.eventError",
    defaultLabel: "error",
  },
  "proactive-message": {
    icon: MessageSquare,
    toneClass: "bg-accent/20 text-accent",
    labelKey: "agentorchestrator.eventProactiveMessage",
    defaultLabel: "proactive message",
  },
  reminder: {
    icon: BellRing,
    toneClass: "bg-warn/20 text-warn",
    labelKey: "agentorchestrator.eventReminder",
    defaultLabel: "reminder",
  },
  workflow: {
    icon: Workflow,
    toneClass: "bg-ok/20 text-ok",
    labelKey: "agentorchestrator.eventWorkflow",
    defaultLabel: "workflow",
  },
  "check-in": {
    icon: HeartPulse,
    toneClass: "bg-accent/20 text-accent",
    labelKey: "agentorchestrator.eventCheckIn",
    defaultLabel: "check in",
  },
  nudge: {
    icon: Zap,
    toneClass: "bg-accent/20 text-accent",
    labelKey: "agentorchestrator.eventNudge",
    defaultLabel: "nudge",
  },
};

function formatIsoTime(
  value: string | null | undefined,
  t: TranslateFn,
): string {
  if (!value)
    return t("agentorchestrator.unknown", { defaultValue: "unknown" });
  const date = new Date(value);
  if (Number.isNaN(date.getTime()))
    return t("agentorchestrator.unknown", { defaultValue: "unknown" });
  return relativeTime(date.getTime(), t);
}

function ActivityItemsContent({
  events,
  t,
  onSelectEvent,
}: {
  events: ActivityEvent[];
  t: TranslateFn;
  onSelectEvent: (event: ActivityEvent) => void;
}) {
  if (events.length === 0) {
    return (
      <EmptyWidgetState
        icon={<Activity className="h-8 w-8" />}
        title={t("agentorchestrator.noRecentActivity", {
          defaultValue: "No recent activity",
        })}
      />
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {events.map((event) => {
        const eventTypeMeta =
          EVENT_TYPE_META[event.eventType] ?? DEFAULT_EVENT_TYPE_META;
        const EventIcon = eventTypeMeta.icon;
        const eventLabel = t(eventTypeMeta.labelKey, {
          defaultValue: eventTypeMeta.defaultLabel,
        });
        const openLabel = event.sessionId
          ? t("agentorchestrator.openSession", {
              defaultValue: "Open session",
            })
          : t("agentorchestrator.openTasks", { defaultValue: "Open tasks" });

        return (
          <button
            key={event.id}
            type="button"
            onClick={() => onSelectEvent(event)}
            aria-label={`${openLabel}: ${event.summary}`}
            className="flex w-full items-start gap-1.5 rounded-sm px-1.5 py-1 text-left transition-colors hover:bg-bg-hover/40   "
          >
            <span className="shrink-0 whitespace-nowrap pt-0.5 text-3xs font-medium tabular-nums text-muted">
              {relativeDuration(event.timestamp)}
            </span>
            <span
              className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm ${eventTypeMeta.toneClass}`}
              role="img"
              title={eventLabel}
            >
              <EventIcon className="h-2.5 w-2.5" />
              <span className="sr-only">{eventLabel}</span>
            </span>
            <span className="min-w-0 flex-1 break-words pt-0.5 text-2xs leading-4 text-txt">
              {event.summary}
            </span>
          </button>
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
  t,
}: {
  run: AppRunSummary;
  attentionReasons: string[];
  app: AppIdentitySource;
  t: TranslateFn;
}) {
  const healthDot =
    run.health.state === "healthy"
      ? "bg-ok"
      : run.health.state === "degraded"
        ? "bg-warn"
        : "bg-danger";
  const ViewerIcon = run.viewerAttachment === "attached" ? Eye : EyeOff;

  return (
    <div className="p-2">
      <div className="flex items-start gap-2">
        <div className="w-20 shrink-0 overflow-hidden">
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
            <span>
              {formatIsoTime(run.lastHeartbeatAt ?? run.updatedAt, t)}
            </span>
          </div>
          <div className="mt-1 line-clamp-2 text-3xs text-muted">
            {run.summary ||
              run.health.message ||
              t("agentorchestrator.runActive", {
                defaultValue: "Run active.",
              })}
          </div>
          {attentionReasons.length > 0 ? (
            <div className="mt-1.5 flex items-center gap-1.5 text-3xs text-warn">
              <AlertTriangle
                className="h-3 w-3 shrink-0"
                aria-label={t("agentorchestrator.needsAttention", {
                  defaultValue: "Needs attention",
                })}
              />
              <span className="truncate">{attentionReasons[0]}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// Stable fallbacks for mounts without a full AppContext (widget hosts in
// fixtures/tests). Inline `?? (() => undefined)` fallbacks mint a NEW function
// identity every render; setState sits in the poll effect's dep array, so an
// unstable identity re-runs the effect on every render (the #11107 crash loop).
const noopSetTab = () => undefined;
const noopSetState = () => undefined;

function AppRunsWidget({
  slot,
  spanClassName = "col-span-2 row-span-1",
}: ChatSidebarWidgetProps) {
  const {
    appRuns,
    setTab: appSetTab,
    setState: appSetState,
    t: appT,
  } = useAppSelectorShallow((s) => ({
    appRuns: s.appRuns,
    setTab: s.setTab,
    setState: s.setState,
    t: s.t,
  }));
  const setTab = appSetTab ?? noopSetTab;
  const setState = appSetState ?? noopSetState;
  const t = appT ?? fallbackTranslate;
  const currentBaseUrl = useAppSelectorShallow(() => client.getBaseUrl());
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the 5s run poll must stay dormant until the session is authenticated.
  const authenticated = useIsAuthenticated();
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
    if (!supportsFullAppShellRoutes(currentBaseUrl) || !authenticated) {
      // Idempotent reset: keep the previous reference when already empty. A
      // fresh `[]` here re-renders unconditionally, and because the update
      // rides a transition lane it dodges React's synchronous nested-update
      // guard — with any unstable dep this loops render→effect→render until
      // the worker OOMs (the #11107 WidgetHost test crash).
      startTransition(() => {
        setRuns((prev) => (prev.length === 0 ? prev : []));
        setState("appRuns", []);
      });
      setError(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    // The 5s poll pushes appRuns into the global AppContext, which re-renders
    // every useApp() consumer. Only push when the run set actually changed so a
    // steady poll doesn't bust the whole app every 5 seconds.
    let lastAppRunsKey = "";

    const refreshRuns = async () => {
      try {
        const nextRuns = await client.listAppRuns();
        const nextRunsSafe = Array.isArray(nextRuns) ? nextRuns : [];
        if (cancelled) return;
        setError(null);
        const nextKey = JSON.stringify(nextRunsSafe);
        const changed = nextKey !== lastAppRunsKey;
        lastAppRunsKey = nextKey;
        startTransition(() => {
          setRuns(nextRunsSafe);
          if (changed) setState("appRuns", nextRunsSafe);
        });
      } catch (refreshError) {
        if (cancelled) return;
        setError(
          getClientErrorMessage(
            refreshError,
            t("agentorchestrator.loadRunsError", {
              defaultValue: "Failed to load app runs.",
            }),
          ),
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
  }, [authenticated, currentBaseUrl, setState, t]);

  if (shouldHideWidget) {
    return null;
  }

  const section = (
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
              aria-label={t("agentorchestrator.resumeViewer", {
                defaultValue: "Resume viewer",
              })}
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
            aria-label={t("agentorchestrator.openApps", {
              defaultValue: "Open apps",
            })}
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
        <div className="mb-2 px-2 py-1.5 text-xs-tight text-danger">
          {error}
        </div>
      ) : null}
      {runs.length === 0 ? (
        loading ? (
          <div className="text-xs-tight text-muted">
            {t("agentorchestrator.loadingRuns", {
              defaultValue: "Loading app runs...",
            })}
          </div>
        ) : (
          <EmptyWidgetState
            icon={<Activity className="h-8 w-8" />}
            title={t("agentorchestrator.noGamesRunning", {
              defaultValue: "No games are running",
            })}
          />
        )
      ) : (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3 text-3xs text-muted">
            <span
              className="inline-flex items-center gap-1"
              title={t("agentorchestrator.currentlyPlaying", {
                defaultValue: "Currently playing",
              })}
            >
              <Eye className="h-3 w-3" />
              {attachedCount}
            </span>
            <span
              className="inline-flex items-center gap-1"
              title={t("agentorchestrator.background", {
                defaultValue: "Background",
              })}
            >
              <EyeOff className="h-3 w-3" />
              {backgroundCount}
            </span>
            <span
              className={`inline-flex items-center gap-1 ${
                needsAttentionCount > 0 ? "text-warn" : "text-ok"
              }`}
              title={t("agentorchestrator.needsAttention", {
                defaultValue: "Needs attention",
              })}
            >
              <AlertTriangle className="h-3 w-3" />
              {needsAttentionCount}
            </span>
          </div>
          {attentionRuns.length > 0 ? (
            <div className="p-2 text-warn">
              <div className="mb-1.5 flex items-center gap-1.5 text-3xs font-semibold uppercase tracking-[0.08em] text-warn">
                <AlertTriangle className="h-3 w-3" />
                {t("agentorchestrator.recovery", { defaultValue: "Recovery" })}
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
                      t={t}
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
                t={t}
              />
            ))}
          </div>
        </div>
      )}
    </WidgetSection>
  );
  // On the home 4-col grid the widget's root element must carry its grid-span
  // classes or it collapses to a one-column cell and its content paints over
  // the neighboring card (#11752). The sidebar stack renders the bare section.
  if (slot === "home") {
    return <div className={`min-w-0 ${spanClassName}`}>{section}</div>;
  }
  return section;
}

function OrchestratorActivityWidget({
  events,
  clearEvents,
  slot,
  spanClassName = "col-span-2 row-span-1",
}: ChatSidebarWidgetProps) {
  const {
    t: appT,
    setState,
    setTab,
  } = useAppSelectorShallow((s) => ({
    t: s.t,
    setState: s.setState,
    setTab: s.setTab,
  }));
  const t = appT ?? fallbackTranslate;
  const nav = useWidgetNavigation();

  // A click navigates to the activity's origin: a sessionId routes into the
  // terminal channel (mirrors ChatView.focusTerminalSession — clear the inbox
  // selection, then focus the PTY session); everything else opens the Tasks
  // tab (mirrors AppRunsWidget's setTab navigation).
  const onSelectEvent = useCallback(
    (event: ActivityEvent) => {
      if (event.sessionId) {
        setState?.("activeInboxChat", null);
        setState?.("activeTerminalSessionId", event.sessionId);
        return;
      }
      setTab?.("tasks");
    },
    [setState, setTab],
  );

  if (events.length === 0) {
    return null;
  }

  // Home slot: a single compact, icon-first, whole-card-clickable tile — the
  // latest activity event's summary as the one datum, event count as the badge.
  // Tapping opens the Tasks tab. The sidebar keeps the full activity list.
  if (slot === "home") {
    const latest = events[0];
    return (
      <div className={`min-w-0 ${spanClassName}`}>
        <HomeWidgetCard
          icon={<Activity />}
          label={t("taskseventspanel.Activity", { defaultValue: "Activity" })}
          value={latest.summary}
          meta={relativeDuration(latest.timestamp)}
          badge={events.length > 1 ? events.length : undefined}
          testId="chat-widget-events"
          ariaLabel={`Activity: ${events.length} events, latest ${latest.summary}. Open tasks.`}
          onActivate={() => nav.openTab("tasks")}
        />
      </div>
    );
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
          aria-label={t("agentorchestrator.clearActivity", {
            defaultValue: "Clear activity",
          })}
          className="h-6 w-6 p-0 text-muted"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      }
      testId="chat-widget-events"
    >
      <ActivityItemsContent
        events={events}
        t={t}
        onSelectEvent={onSelectEvent}
      />
    </WidgetSection>
  );
}

/**
 * Connected coding accounts + their session/weekly usage, the active selection
 * strategy, and the live sub-agent → account assignment map. Surfaces the
 * orchestrator's multi-account state on the dashboard; deep-links to Settings
 * to connect more.
 */
function OrchestratorAccountsWidget(_props: ChatSidebarWidgetProps) {
  const { t: appT, setTab } = useAppSelectorShallow((s) => ({
    t: s.t,
    setTab: s.setTab,
  }));
  const t = appT ?? fallbackTranslate;
  // Auth gate (#11084): dormant until the session is authenticated so the
  // 15s poll never fires 401s from an unauthenticated shell.
  const authenticated = useIsAuthenticated();
  const [accounts, setAccounts] = useState<AccountsListResponse | null>(null);
  const [overview, setOverview] = useState<OrchestratorAccountOverview | null>(
    null,
  );
  const [rooms, setRooms] = useState<OrchestratorRoomRosterOverview | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    const [acctRes, ovRes, roomsRes] = await Promise.allSettled([
      client.listAccounts(),
      client.getOrchestratorAccounts(),
      client.getOrchestratorRooms(),
    ]);
    if (acctRes.status === "fulfilled") setAccounts(acctRes.value);
    if (ovRes.status === "fulfilled") setOverview(ovRes.value);
    if (roomsRes.status === "fulfilled") setRooms(roomsRes.value);
    setLoading(false);
  }, [authenticated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The widget fires three parallel calls per tick — gate the recurring poll on
  // document visibility so a backgrounded window stops hitting the API.
  useIntervalWhenDocumentVisible(() => void refresh(), 15_000);

  if (loading) return null;

  return (
    <OrchestratorAccountsView
      accounts={accounts}
      overview={overview}
      rooms={rooms}
      t={t}
      onConnect={() => setTab?.("settings")}
    />
  );
}

/**
 * The live room swarm: every active coding-task room and the orchestrator +
 * sub-agents working inside it. A room-scoped sibling to the accounts widget:
 * accounts answers "who's connected and how much have they spent", rooms answers
 * "which agents are live in which task right now and what is each doing".
 */
function OrchestratorRoomWidget(_props: ChatSidebarWidgetProps) {
  const { t: appT } = useAppSelectorShallow((s) => ({ t: s.t }));
  const t = appT ?? fallbackTranslate;
  // Auth gate (#11084): same as the accounts widget — no polling before auth.
  const authenticated = useIsAuthenticated();
  const [rooms, setRooms] = useState<OrchestratorRoomRosterOverview | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    try {
      const next = await client.getOrchestratorRooms();
      setRooms(next);
    } catch {
      // Leave the last good roster in place on a transient poll failure.
    } finally {
      setLoading(false);
    }
  }, [authenticated]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Same visibility-gated cadence as the accounts widget so a backgrounded
  // window stops polling the orchestrator API.
  useIntervalWhenDocumentVisible(() => void refresh(), 15_000);

  if (loading) return null;
  if ((rooms?.rooms?.length ?? 0) === 0) return null;

  return <OrchestratorRoomView rooms={rooms} t={t} />;
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
      id: "agent-orchestrator.accounts",
      pluginId: "agent-orchestrator",
      order: 250,
      defaultEnabled: true,
      Component: OrchestratorAccountsWidget,
    },
    {
      id: "agent-orchestrator.rooms",
      pluginId: "agent-orchestrator",
      order: 275,
      defaultEnabled: true,
      Component: OrchestratorRoomWidget,
    },
    {
      id: "agent-orchestrator.activity",
      pluginId: "agent-orchestrator",
      order: 300,
      defaultEnabled: true,
      Component: OrchestratorActivityWidget,
    },
  ];
