/**
 * Unified feed for workflows, prompt automations, and scheduled items with
 * direct handoff to their matching editors. It consumes the aggregate
 * `/api/automations` surface and keeps loading, healthy-empty, unavailable,
 * upgrade-required, and error states visually distinct.
 */

import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  Clock,
  History,
  PlayCircle,
  Plus,
  Rocket,
  Workflow,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgentElement } from "../../agent-surface";
import { client } from "../../api";
import type { WorkflowDefinition } from "../../api/client-types-chat";
import type {
  AutomationItem,
  AutomationListResponse,
} from "../../api/client-types-config";
import { isApiError } from "../../api/client-types-core";
import { workflowSurfaceBaseUrl } from "../../api/workflow-surface-routing";
import { resolveCloudConsoleUrl } from "../../cloud/applications/lib/native-cloud-nav";
import { getCached, invalidate, setCached } from "../../hooks/resource-cache";
import { useAutomationDeepLink } from "../../hooks/useAutomationDeepLink";
import { useFetchData } from "../../hooks/useFetchData";
import {
  FramedPage,
  FramedPageBody,
  FramedPageHeader,
  FramedPageNavigation,
} from "../../layouts/framed-page";
import { useTranslation } from "../../state/TranslationContext.hooks";
import {
  FEED_FILTERS,
  type FeedFilter,
  isFeedFilter,
  passesFilter,
} from "../../utils/automation-feed-filter";
import { formatSchedule } from "../../utils/cron-format";
import { mergeUnifiedTasks } from "../../utils/merge-unified-tasks";
import { openExternalUrl } from "../../utils/openExternalUrl";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { ListSkeleton } from "../ui/skeleton-layouts";
import { Spinner } from "../ui/spinner";
import { StatusDot } from "../ui/status-badge";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { ScheduledTaskEditor } from "./ScheduledTaskEditor";
import { TaskEditor } from "./TaskEditor";
import { WorkflowEditor } from "./WorkflowEditor";
import {
  VISUALIZE_WORKFLOW_EVENT,
  type VisualizeWorkflowEventDetail,
} from "./workflow-graph-events";

export type { FeedFilter } from "../../utils/automation-feed-filter";

type EditorState =
  | { kind: "none" }
  | { kind: "task"; taskId: string | null }
  | { kind: "workflow"; workflowId: string | null }
  | { kind: "scheduled"; itemId: string };

export interface AutomationsFeedProps {
  /**
   * Cred types the user has already connected. Used to compute the
   * per-row "Connect <Provider> →" missing-creds banner. Keep this
   * driven from the host (App.tsx pulls connector accounts) so the feed
   * stays a pure display component.
   */
  connectedCredTypes?: ReadonlySet<string>;
}

const FILTER_LABELS: Record<FeedFilter, { key: string; defaultLabel: string }> =
  {
    all: { key: "automationsfeed.filterAll", defaultLabel: "All" },
    prompts: { key: "automationsfeed.filterPrompts", defaultLabel: "Prompts" },
    workflows: {
      key: "automationsfeed.filterWorkflows",
      defaultLabel: "Workflows",
    },
    active: { key: "automationsfeed.filterActive", defaultLabel: "Active" },
    inactive: {
      key: "automationsfeed.filterInactive",
      defaultLabel: "Inactive",
    },
  };
function isUnavailableScheduledTaskSupplement(error: unknown): boolean {
  if (!isApiError(error)) return false;
  if (error.status === 404) return true;
  return (
    error.status === 500 &&
    error.path.startsWith("/api/lifeops/scheduled-tasks") &&
    error.message.includes("cannot be parsed as a URL against")
  );
}
const NEW_AUTOMATION_LINK_ID = "__new__";

/** Namespaces cached rows by the currently selected local or Cloud agent. */
export function automationListCacheKey(baseUrl: string): string {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "") || "local";
  return `automations:list:${normalizedBase}`;
}

interface WorkflowServiceIssue {
  kind: "unavailable" | "error";
  title: string;
  message: string;
  upgradeAgentId?: string;
}

type WorkflowRouteIssue =
  | { kind: "unavailable"; message: string }
  | { kind: "requires-dedicated"; message: string; agentId: string };

function cloudAgentIdFromApiBase(baseUrl: string): string | null {
  try {
    const match = /^\/api\/v1\/eliza\/agents\/([^/]+)(?:\/bridge)?\/?$/.exec(
      new URL(baseUrl).pathname,
    );
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    // error-policy:J3 a malformed or non-cloud API base is an explicit invalid
    // signal; it must not produce a guessed agent-management destination.
    return null;
  }
}

interface FeedRow {
  key: string;
  kind: "task" | "workflow";
  title: string;
  schedule: string | null;
  active: boolean;
  status: string;
  lastUpdated: string | null;
  lastRunStatus: NonNullable<AutomationItem["lastExecution"]>["status"] | null;
  lastRunError: string | null;
  executionFetchError: string | null;
  source: AutomationItem;
}

function formatInterval(intervalMs: number): string {
  const minutes = Math.round(intervalMs / 60_000);
  if (minutes < 60) {
    return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }
  const days = Math.round(hours / 24);
  return days === 1 ? "Every day" : `Every ${days} days`;
}

/**
 * Derive a schedule label from an automation item's `schedules`
 * (`TriggerSummary[]` populated by the `/api/automations` builder from
 * `metadata.trigger`). Cron shows the humanized cadence; an on-event trigger
 * shows "On <event>"; otherwise the trigger's display name.
 */
function schedulesLabel(
  item: AutomationItem,
  t: ReturnType<typeof useTranslation>["t"],
): string | null {
  return (
    item.schedules
      .map((trigger) => {
        if (trigger.cronExpression)
          return formatSchedule(trigger.cronExpression);
        if (trigger.triggerType === "event" && trigger.eventKind) {
          return t("automationsfeed.onEvent", {
            event: trigger.eventKind,
            defaultValue: "On {{event}}",
          });
        }
        if (trigger.intervalMs) return formatInterval(trigger.intervalMs);
        if (trigger.displayName) return trigger.displayName;
        return null;
      })
      .filter((s): s is string => Boolean(s))
      .join(", ") || null
  );
}

function automationToRow(
  item: AutomationItem,
  t: ReturnType<typeof useTranslation>["t"],
): FeedRow {
  const isWorkflow = item.type === "workflow";
  const schedule = schedulesLabel(item, t);

  return {
    key: item.id,
    kind: isWorkflow ? "workflow" : "task",
    title:
      item.title || t("automationsfeed.untitled", { defaultValue: "Untitled" }),
    schedule,
    active: item.enabled,
    status: item.status,
    lastUpdated: item.updatedAt,
    lastRunStatus: item.lastExecution?.status ?? null,
    lastRunError: item.lastExecution?.errorMessage ?? null,
    executionFetchError: item.executionFetchError ?? null,
    source: item,
  };
}

export function AutomationsFeed({
  connectedCredTypes,
}: AutomationsFeedProps = {}) {
  const { t } = useTranslation();
  const apiBaseUrl = client.baseUrl;
  // The base the workflow surface is actually served from. On a mobile device
  // whose bundled runtime cannot host plugin-workflow this resolves to the
  // linked Cloud agent's base, so rows cache under the agent that owns them and
  // the upgrade CTA can name the right Cloud agent.
  const workflowApiBase = workflowSurfaceBaseUrl(apiBaseUrl);
  const cacheKey = automationListCacheKey(workflowApiBase);
  // Seed from the shared cache so a revisit paints the last-known automations
  // instantly and revalidates silently, instead of flashing a spinner.
  const cachedAutomations = getCached<AutomationListResponse>(cacheKey);
  const [dataState, setDataState] = useState<{
    cacheKey: string;
    data: AutomationListResponse | null;
  }>(() => ({ cacheKey, data: cachedAutomations?.data ?? null }));
  const data =
    dataState.cacheKey === cacheKey
      ? dataState.data
      : (cachedAutomations?.data ?? null);
  const [loading, setLoading] = useState(!cachedAutomations);
  const [error, setError] = useState<string | null>(null);
  const [runError, setRunError] = useState<{
    workflowId: string;
    message: string;
  } | null>(null);
  const [workflowRouteIssue, setWorkflowRouteIssue] =
    useState<WorkflowRouteIssue | null>(null);
  const runningWorkflowIdsRef = useRef(new Set<string>());
  const activeCacheKeyRef = useRef(cacheKey);
  const [runningWorkflowIds, setRunningWorkflowIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const { link, setLink } = useAutomationDeepLink();
  // Scheduled-task rows open a LifeOps verb panel. They are not part of the
  // workflow/task deep-link schema (they route to the runner, not workflow
  // CRUD), so a small local id selects the scheduled editor and takes
  // precedence over the deep-link-derived editor.
  const [scheduledEditorId, setScheduledEditorId] = useState<string | null>(
    null,
  );
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  const editor: EditorState = useMemo(() => {
    if (scheduledEditorId)
      return { kind: "scheduled", itemId: scheduledEditorId };
    if (link.kind === "list") return { kind: "none" };
    if (link.kind === "workflow")
      return {
        kind: "workflow",
        workflowId: link.id === NEW_AUTOMATION_LINK_ID ? null : link.id,
      };
    return {
      kind: "task",
      taskId: link.id === NEW_AUTOMATION_LINK_ID ? null : link.id,
    };
  }, [link, scheduledEditorId]);

  const setEditor = useCallback(
    (next: EditorState) => {
      if (next.kind === "scheduled") {
        setScheduledEditorId(next.itemId);
        return;
      }
      setScheduledEditorId(null);
      if (next.kind === "none") setLink({ kind: "list" });
      else if (next.kind === "workflow")
        setLink({
          kind: "workflow",
          id: next.workflowId ?? NEW_AUTOMATION_LINK_ID,
        });
      else
        setLink({
          kind: "task",
          id: next.taskId ?? NEW_AUTOMATION_LINK_ID,
        });
    },
    [setLink],
  );

  const refresh = useCallback(
    async (options?: { silent?: boolean }) => {
      const requestCacheKey = cacheKey;
      if (activeCacheKeyRef.current === requestCacheKey) {
        if (!options?.silent) setLoading(true);
        setError(null);
        setWorkflowRouteIssue(null);
      }
      try {
        // Unified read: automations (workflows + workbench tasks + triggers)
        // merged client-side with LifeOps scheduled tasks.
        const [res, scheduled] = await Promise.all([
          client.listAutomations(),
          client
            .listScheduledTasks({ ownerVisibleOnly: true })
            .catch((scheduledError) => {
              // error-policy:J4 some runtimes intentionally omit the LifeOps
              // route. A reverse-proxy origin parse failure is also scoped to
              // this optional supplement: keep the core automation feed while
              // ordinary storage/runtime failures remain explicit.
              if (isUnavailableScheduledTaskSupplement(scheduledError)) {
                return { tasks: [] };
              }
              throw scheduledError;
            }),
        ]);
        const merged: AutomationListResponse = {
          ...res,
          automations: mergeUnifiedTasks(res.automations, scheduled.tasks),
        };
        setCached(requestCacheKey, merged);
        if (activeCacheKeyRef.current === requestCacheKey) {
          setDataState({ cacheKey: requestCacheKey, data: merged });
        }
      } catch (e) {
        // error-policy:J4 this view boundary converts capability and load
        // failures into explicit unavailable, upgrade, or retryable states.
        if (isApiError(e) && e.code === "workflow_requires_dedicated") {
          const agentId = cloudAgentIdFromApiBase(workflowApiBase);
          if (agentId && activeCacheKeyRef.current === requestCacheKey) {
            setDataState({ cacheKey: requestCacheKey, data: null });
            invalidate(requestCacheKey);
            setWorkflowRouteIssue({
              kind: "requires-dedicated",
              message: e.message,
              agentId,
            });
            return;
          }
        }
        // A runtime without the workflow route is explicitly unavailable. It
        // must remain distinct from a successful empty list so users know why
        // workflows cannot be created or run here.
        if (isApiError(e) && e.status === 404) {
          if (activeCacheKeyRef.current === requestCacheKey) {
            setDataState({ cacheKey: requestCacheKey, data: null });
            invalidate(requestCacheKey);
            setWorkflowRouteIssue({
              kind: "unavailable",
              message:
                "The workflow API is not available on this runtime. Open elizaOS on a desktop with the workflow service running to create or run workflows.",
            });
          }
          return;
        }
        if (activeCacheKeyRef.current === requestCacheKey) {
          setError(
            e instanceof Error
              ? e.message
              : t("automationsfeed.loadError", {
                  defaultValue: "Failed to load automations.",
                }),
          );
        }
      } finally {
        if (activeCacheKeyRef.current === requestCacheKey) {
          setLoading(false);
        }
      }
    },
    [cacheKey, t, workflowApiBase],
  );

  useEffect(() => {
    const cached = getCached<AutomationListResponse>(cacheKey);
    activeCacheKeyRef.current = cacheKey;
    setDataState({ cacheKey, data: cached?.data ?? null });
    setLoading(!cached);
    setError(null);
    setRunError(null);
    setWorkflowRouteIssue(null);
    // Revalidate silently when this agent's cached automations are already on
    // screen. Agent switches never borrow another agent's last-known rows.
    void refresh({ silent: cached != null });
  }, [cacheKey, refresh]);

  const runWorkflowNow = useCallback(
    async (workflowId: string) => {
      if (runningWorkflowIdsRef.current.has(workflowId)) return;
      runningWorkflowIdsRef.current.add(workflowId);
      setRunningWorkflowIds(new Set(runningWorkflowIdsRef.current));
      setRunError(null);
      try {
        await client.runWorkflowDefinition(workflowId);
        await refresh();
      } catch (e) {
        // error-policy:J4 run-now is a user interaction boundary; a failed
        // execution remains distinct from a feed-load failure so its retry
        // repeats the operation the user asked for.
        setRunError({
          workflowId,
          message:
            e instanceof Error
              ? e.message
              : t("automationsfeed.runError", {
                  defaultValue: "Failed to run automation.",
                }),
        });
      } finally {
        runningWorkflowIdsRef.current.delete(workflowId);
        setRunningWorkflowIds(new Set(runningWorkflowIdsRef.current));
      }
    },
    [refresh, t],
  );

  const automations = useMemo(
    () => (Array.isArray(data?.automations) ? data.automations : []),
    [data],
  );
  const workflowServiceIssue = useMemo<WorkflowServiceIssue | null>(() => {
    if (workflowRouteIssue?.kind === "requires-dedicated") {
      return {
        kind: "unavailable",
        title: "Dedicated agent required",
        message: workflowRouteIssue.message,
        upgradeAgentId: workflowRouteIssue.agentId,
      };
    }
    if (workflowRouteIssue?.kind === "unavailable") {
      return {
        kind: "unavailable",
        title: "Workflow service unavailable",
        message: workflowRouteIssue.message,
      };
    }
    const status = data?.workflowStatus;
    if (status?.mode === "disabled") {
      return {
        kind: "unavailable",
        title: "Workflow service unavailable",
        message:
          data?.workflowFetchError ??
          "The workflow service is not enabled on this runtime.",
      };
    }
    if (data?.workflowFetchError) {
      return {
        kind: "error",
        title: "Workflows couldn't be loaded",
        message: data.workflowFetchError,
      };
    }
    if (status?.status === "error") {
      return {
        kind: "error",
        title: "Workflow service error",
        message:
          "The workflow service reported an error. Retry after checking the runtime status.",
      };
    }
    return null;
  }, [data, workflowRouteIssue]);
  const loadErrorIssue = useMemo<WorkflowServiceIssue | null>(
    () =>
      error
        ? {
            kind: "error",
            title: "Automations couldn't be loaded",
            message: error,
          }
        : null,
    [error],
  );
  const runErrorIssue = useMemo<WorkflowServiceIssue | null>(
    () =>
      runError
        ? {
            kind: "error",
            title: "Run failed",
            message: runError.message,
          }
        : null,
    [runError],
  );
  const openDedicatedUpgrade = useCallback((agentId: string) => {
    void openExternalUrl(
      resolveCloudConsoleUrl(`/cloud/agents/${encodeURIComponent(agentId)}`),
    );
  }, []);

  // Behavior #4: external "show only failed runs" / chip filter dispatcher.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ filter?: FeedFilter }>).detail;
      if (detail?.filter) setFilter(detail.filter);
    };
    window.addEventListener("eliza:automations:setFilter", handler);
    return () =>
      window.removeEventListener("eliza:automations:setFilter", handler);
  }, []);

  // Behavior #3: chat agent says "show me this workflow" → scroll + open.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<VisualizeWorkflowEventDetail>)
        .detail;
      if (!detail?.workflowId) return;
      setLink({ kind: "workflow", id: detail.workflowId });
      const row = rowRefs.current.get(detail.workflowId);
      row?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener(VISUALIZE_WORKFLOW_EVENT, handler);
    return () => window.removeEventListener(VISUALIZE_WORKFLOW_EVENT, handler);
  }, [setLink]);

  const allRows = useMemo(
    () => automations.map((item) => automationToRow(item, t)),
    [automations, t],
  );
  const rows = useMemo(() => {
    return allRows.filter((r) => passesFilter(r, filter));
  }, [allRows, filter]);

  const filterCounts = useMemo<Record<FeedFilter, number>>(
    () => ({
      all: allRows.length,
      prompts: allRows.filter((r) => r.kind === "task").length,
      workflows: allRows.filter((r) => r.kind === "workflow").length,
      active: allRows.filter((r) => r.active).length,
      inactive: allRows.filter((r) => !r.active).length,
    }),
    [allRows],
  );

  const newAutomationAction = useAgentElement<HTMLButtonElement>({
    id: "action-new",
    role: "button",
    label: t("automationsfeed.newAutomation", {
      defaultValue: "New automation",
    }),
    group: "automations-actions",
    description: "Choose a workflow or prompt automation",
    onActivate: () => setCreateOpen(true),
  });
  const newWorkflowAction = useAgentElement<HTMLDivElement>({
    id: "action-new-workflow",
    role: "button",
    label: "New workflow",
    group: "automations-actions",
    description: "Open the Smithers workflow studio",
    onActivate: () => setEditor({ kind: "workflow", workflowId: null }),
  });
  const newPromptAction = useAgentElement<HTMLDivElement>({
    id: "action-new-prompt",
    role: "button",
    label: "New prompt automation",
    group: "automations-actions",
    description: "Open the prompt automation editor",
    onActivate: () => setEditor({ kind: "task", taskId: null }),
  });

  // Editor mode
  if (editor.kind === "scheduled") {
    const item = data?.automations.find((a) => a.id === editor.itemId) ?? null;
    if (item) {
      return (
        <ScheduledTaskEditor
          item={item}
          onApplied={() => {
            setEditor({ kind: "none" });
            void refresh();
          }}
          onCancel={() => setEditor({ kind: "none" })}
        />
      );
    }
    // Item vanished (e.g. refreshed away) — fall through to the list.
  }
  if (editor.kind === "task") {
    // `editor.taskId` is a workbench-task id for a plain task, or a trigger id
    // for a prompt-kind (recurring/event) automation.
    const existing =
      editor.taskId && data
        ? (data.automations.find((a) => a.task?.id === editor.taskId) ??
          data.automations.find((a) => a.triggerId === editor.taskId))
        : null;
    const trigger = existing?.trigger;
    const initial =
      trigger && trigger.kind === "prompt"
        ? {
            triggerId: trigger.id,
            name: trigger.displayName,
            prompt: trigger.instructions,
            scheduleKind: (trigger.triggerType === "event"
              ? "event"
              : "recurring") as "event" | "recurring",
            cronExpression: trigger.cronExpression ?? "",
            eventName: trigger.eventKind ?? "",
          }
        : {
            id: existing?.task?.id,
            name: existing?.task?.name,
            prompt: existing?.task?.description,
            scheduleKind: "once" as const,
          };
    return (
      <TaskEditor
        initial={initial}
        onSaved={() => {
          setEditor({ kind: "none" });
          void refresh();
        }}
        onCancel={() => setEditor({ kind: "none" })}
      />
    );
  }
  if (editor.kind === "workflow") {
    return (
      <WorkflowEditorLoader
        workflowId={editor.workflowId}
        onSaved={() => {
          void refresh();
        }}
        onCancel={() => setEditor({ kind: "none" })}
      />
    );
  }

  const workflowOnlyEmpty = filter === "workflows";
  const emptyStateLabel = workflowOnlyEmpty
    ? t("automationsfeed.emptyWorkflows", { defaultValue: "No workflows" })
    : t("automationsfeed.emptyHeadline", {
        defaultValue: "Nothing scheduled yet",
      });

  const feedContent = (
    <ShellViewAgentSurface viewId="automations">
      <FramedPage
        gutterOwner="framed-page"
        data-chat-clearance-aware="true"
        data-testid="automations-layout"
      >
        {/* Uniform view header (#13451/#13597): bare-icon back, centered title. */}
        <FramedPageHeader
          title={t("automationsfeed.title", { defaultValue: "Automations" })}
          actions={
            <DropdownMenu open={createOpen} onOpenChange={setCreateOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  ref={newAutomationAction.ref}
                  type="button"
                  variant="selection"
                  size="compact"
                  aria-label="New automation"
                  aria-expanded={createOpen}
                  {...newAutomationAction.agentProps}
                >
                  <Plus className="size-4" aria-hidden />
                  New
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-52"
                data-testid="automation-create-menu"
              >
                <DropdownMenuLabel>Create automation</DropdownMenuLabel>
                <DropdownMenuItem
                  ref={newWorkflowAction.ref}
                  className="gap-2"
                  aria-label="New workflow"
                  onSelect={() =>
                    setEditor({ kind: "workflow", workflowId: null })
                  }
                  {...newWorkflowAction.agentProps}
                >
                  <Workflow className="size-4" aria-hidden />
                  Workflow
                </DropdownMenuItem>
                <DropdownMenuItem
                  ref={newPromptAction.ref}
                  className="gap-2"
                  aria-label="New prompt automation"
                  onSelect={() => setEditor({ kind: "task", taskId: null })}
                  {...newPromptAction.agentProps}
                >
                  <CheckCircle2 className="size-4" aria-hidden />
                  Prompt automation
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
        {data && !(workflowServiceIssue && rows.length === 0) ? (
          <FramedPageNavigation className="flex items-center justify-between gap-3">
            <span className="text-sm text-muted">Show</span>
            <AutomationFilterMenu
              filter={filter}
              counts={filterCounts}
              onSelect={setFilter}
            />
          </FramedPageNavigation>
        ) : null}
        <FramedPageBody
          scroll="page"
          data-testid="automations-scroll-region"
          className="device-layout gap-4 overflow-x-hidden py-4"
        >
          <div
            data-testid="automations-shell"
            className="flex w-full flex-col gap-4"
          >
            {workflowServiceIssue && rows.length > 0 && (
              <WorkflowServiceIssuePanel
                issue={workflowServiceIssue}
                onRetry={() => void refresh()}
                onUpgrade={openDedicatedUpgrade}
              />
            )}

            {loadErrorIssue && rows.length > 0 && (
              <WorkflowServiceIssuePanel
                issue={loadErrorIssue}
                onRetry={() => void refresh()}
                onUpgrade={openDedicatedUpgrade}
              />
            )}

            {runErrorIssue && runError && rows.length > 0 && (
              <WorkflowServiceIssuePanel
                issue={runErrorIssue}
                onRetry={() => void runWorkflowNow(runError.workflowId)}
                onUpgrade={openDedicatedUpgrade}
                actionLabel="Run again"
              />
            )}

            <div className="border-y border-border/50">
              {(loading || dataState.cacheKey !== cacheKey) && !data ? (
                <ListSkeleton rows={6} className="p-3" />
              ) : workflowServiceIssue && rows.length === 0 ? (
                <WorkflowServiceIssuePanel
                  issue={workflowServiceIssue}
                  onRetry={() => void refresh()}
                  onUpgrade={openDedicatedUpgrade}
                  full
                />
              ) : loadErrorIssue && rows.length === 0 ? (
                <WorkflowServiceIssuePanel
                  issue={loadErrorIssue}
                  onRetry={() => void refresh()}
                  onUpgrade={openDedicatedUpgrade}
                  full
                />
              ) : rows.length === 0 ? (
                // Designed-empty render only. A default workflow is seeded on first
                // run so this state is unreachable in practice (#13597); it exists
                // for the deleted-everything edge. NO create CTA — the agent offers
                // to re-create a workflow from chat instead.
                <div
                  data-testid="automations-empty-state"
                  role="status"
                  aria-label={workflowOnlyEmpty ? emptyStateLabel : undefined}
                  className="flex flex-col items-center gap-5 px-6 py-14 text-center [@media(orientation:landscape)_and_(max-height:520px)]:gap-2 [@media(orientation:landscape)_and_(max-height:520px)]:px-4 [@media(orientation:landscape)_and_(max-height:520px)]:py-3"
                >
                  <AutomationEmptyIllustration />
                  <p
                    className={
                      workflowOnlyEmpty
                        ? "sr-only"
                        : "text-sm font-medium text-txt"
                    }
                  >
                    {emptyStateLabel}
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-border/40">
                  {rows.map((row) => (
                    <FeedRowItem
                      key={row.key}
                      row={row}
                      connectedCredTypes={connectedCredTypes}
                      registerRef={(el) => {
                        const id = row.source.workflowId ?? row.source.id;
                        if (el) rowRefs.current.set(id, el);
                        else rowRefs.current.delete(id);
                      }}
                      isRunning={
                        row.source.workflowId
                          ? runningWorkflowIds.has(row.source.workflowId)
                          : false
                      }
                      onOpen={() => {
                        if (row.source.source === "scheduled_task") {
                          setEditor({
                            kind: "scheduled",
                            itemId: row.source.id,
                          });
                        } else if (row.kind === "task") {
                          // A prompt-kind trigger has no backing workbench task —
                          // key the editor by its trigger id instead.
                          setEditor({
                            kind: "task",
                            taskId:
                              row.source.task?.id ??
                              row.source.triggerId ??
                              null,
                          });
                        } else {
                          setEditor({
                            kind: "workflow",
                            workflowId: row.source.workflowId ?? null,
                          });
                        }
                      }}
                      onRunNow={async () => {
                        if (row.kind !== "workflow" || !row.source.workflowId)
                          return;
                        await runWorkflowNow(row.source.workflowId);
                      }}
                    />
                  ))}
                </ul>
              )}
            </div>
          </div>
        </FramedPageBody>
      </FramedPage>
    </ShellViewAgentSurface>
  );

  return feedContent;
}

function WorkflowServiceIssuePanel({
  issue,
  onRetry,
  onUpgrade,
  actionLabel = "Retry",
  full = false,
}: {
  issue: WorkflowServiceIssue;
  onRetry: () => void;
  onUpgrade: (agentId: string) => void;
  actionLabel?: string;
  full?: boolean;
}) {
  const tone =
    issue.kind === "error"
      ? "border-danger/20 bg-danger/10 text-accent-muted dark:text-danger"
      : "border-warning/25 bg-warning/10 text-accent-muted dark:text-warning";
  const upgradeAgentId = issue.upgradeAgentId;
  return (
    <div
      role="alert"
      data-testid="workflow-service-state"
      className={`flex items-start gap-3 border p-3 text-sm ${tone} ${
        full
          ? "min-h-44 flex-col items-center justify-center text-center"
          : "rounded-sm"
      }`}
    >
      <AlertTriangle className="size-5 shrink-0" aria-hidden />
      <div className={full ? "max-w-lg" : "min-w-0 flex-1"}>
        <p className="font-medium">{issue.title}</p>
        <p className="mt-1 text-xs opacity-90">{issue.message}</p>
      </div>
      {upgradeAgentId ? (
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => onUpgrade(upgradeAgentId)}
        >
          <Rocket className="size-4" aria-hidden />
          Upgrade to Dedicated
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onRetry}
        >
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

function AutomationFilterMenu({
  filter,
  counts,
  onSelect,
}: {
  filter: FeedFilter;
  counts: Readonly<Record<FeedFilter, number>>;
  onSelect: (filter: FeedFilter) => void;
}) {
  const { t } = useTranslation();
  const selectedLabel = t(FILTER_LABELS[filter].key, {
    defaultValue: FILTER_LABELS[filter].defaultLabel,
  });
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "filter-automations",
    role: "button",
    label: `Filter automations, ${selectedLabel} selected`,
    group: "automations-filters",
    status: filter,
    description: "Choose which automations appear in the feed",
  });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          ref={ref}
          variant="ghostMuted"
          size="dense"
          className="gap-1.5"
          aria-label={`Filter automations, ${selectedLabel} selected`}
          {...agentProps}
        >
          <span>{selectedLabel}</span>
          <span className="tabular-nums text-muted">({counts[filter]})</span>
          <ChevronDown className="size-4" aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel>Filter automations</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filter}
          onValueChange={(value) => {
            if (isFeedFilter(value)) onSelect(value);
          }}
        >
          {FEED_FILTERS.map((option) => (
            <DropdownMenuRadioItem key={option} value={option}>
              <span className="flex-1">
                {t(FILTER_LABELS[option].key, {
                  defaultValue: FILTER_LABELS[option].defaultLabel,
                })}
              </span>
              <span className="tabular-nums text-muted">{counts[option]}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function FeedRowItem({
  row,
  onOpen,
  onRunNow,
  isRunning,
  connectedCredTypes: _connectedCredTypes,
  registerRef,
}: {
  row: FeedRow;
  onOpen: () => void;
  onRunNow: () => void;
  isRunning: boolean;
  connectedCredTypes?: ReadonlySet<string>;
  registerRef?: (el: HTMLLIElement | null) => void;
}) {
  const { t } = useTranslation();
  const isWorkflow = row.kind === "workflow";
  const Icon = isWorkflow ? Workflow : CheckCircle2;
  const iconToneClass = isWorkflow
    ? "text-accent-muted dark:text-accent"
    : "text-muted-strong";
  const workflowId = row.source.workflowId ?? row.source.id;
  const openAction = useAgentElement<HTMLButtonElement>({
    id: `open-${row.kind}-${row.source.workflowId ?? row.source.taskId ?? row.key}`,
    role: "button",
    label: `Open ${row.title}`,
    group: "automations-list",
    description:
      row.kind === "workflow"
        ? "Open workflow graph, runs, logs, and JSON"
        : "Open prompt automation schedule and prompt",
    status: row.active ? "active" : "inactive",
    onActivate: onOpen,
  });
  const runAction = useAgentElement<HTMLButtonElement>({
    id: `run-workflow-${workflowId}`,
    role: "button",
    label: `Run ${row.title} now`,
    group: "workflow-actions",
    description: "Run this workflow once and refresh the automation dashboard",
    status:
      isRunning ||
      row.lastRunStatus === "running" ||
      row.lastRunStatus === "waiting"
        ? "busy"
        : isWorkflow
          ? "active"
          : "inactive",
    onActivate: onRunNow,
  });
  const lastRunLabel =
    row.lastRunStatus === "error" && row.lastRunError
      ? `Failed: ${row.lastRunError}`
      : row.lastRunStatus
        ? t(`automationsfeed.run.${row.lastRunStatus}`, {
            defaultValue: row.lastRunStatus,
          })
        : null;
  return (
    <li
      ref={registerRef}
      className="group flex items-center gap-3 py-3 transition-colors hover:bg-bg-accent/40"
    >
      <Button
        ref={openAction.ref}
        onClick={onOpen}
        variant="transparent"
        size="rowContent"
        align="start"
        className="min-w-0 flex-1 items-center whitespace-normal"
        {...openAction.agentProps}
      >
        <Icon className={`size-4 shrink-0 ${iconToneClass}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-txt">
              {row.title}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 text-xs ${
                row.active ? "text-ok-foreground" : "text-muted-strong"
              }`}
            >
              <StatusDot tone={row.active ? "success" : "muted"} />
              {row.active
                ? t("automationsfeed.active", { defaultValue: "Active" })
                : t("automationsfeed.inactive", { defaultValue: "Inactive" })}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-strong">
            {row.schedule && (
              <RowChip
                icon={<CalendarClock className="size-3" />}
                label={row.schedule}
                tone="accent"
              />
            )}
            {lastRunLabel && row.lastRunStatus && (
              <RowChip
                icon={<History className="size-3" />}
                label={lastRunLabel}
                tone={
                  row.lastRunStatus === "error"
                    ? "danger"
                    : row.lastRunStatus === "success"
                      ? "success"
                      : "muted"
                }
              />
            )}
            {row.executionFetchError && (
              <RowChip
                icon={<AlertTriangle className="size-3" />}
                label={`Run history unavailable: ${row.executionFetchError}`}
                tone="danger"
              />
            )}
            {!row.schedule && row.lastUpdated && (
              <RowChip
                icon={<Clock className="size-3" />}
                label={new Date(row.lastUpdated).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              />
            )}
          </div>
        </div>
      </Button>
      {row.kind === "workflow" && (
        <Button
          ref={runAction.ref}
          aria-label={t("automationsfeed.runWorkflowNow", {
            name: row.title,
            defaultValue: "Run {{name}} now",
          })}
          aria-busy={isRunning}
          disabled={isRunning}
          onClick={onRunNow}
          variant="ghostMuted"
          size="icon-sm"
          {...runAction.agentProps}
        >
          {isRunning ? (
            <Spinner size={14} aria-hidden />
          ) : (
            <PlayCircle className="size-3.5" aria-hidden />
          )}
        </Button>
      )}
    </li>
  );
}

function RowChip({
  icon,
  label,
  tone = "muted",
}: {
  icon: ReactNode;
  label: string;
  tone?: "muted" | "accent" | "success" | "danger";
}) {
  const toneClasses = {
    muted: "text-muted-strong",
    accent: "text-accent-muted dark:text-accent",
    success: "text-ok-foreground",
    danger: "text-accent-muted dark:text-destructive",
  }[tone];
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${toneClasses}`}>
      <span className="[&>svg]:h-3 [&>svg]:w-3">{icon}</span>
      <span className="truncate">{label}</span>
    </span>
  );
}

/**
 * Generative clock + workflow-node motif for the empty state. Pure SVG with
 * gradient fills driven by the theme accent token, so it tracks light/dark and
 * brand color without bitmap assets.
 */
function AutomationEmptyIllustration() {
  return (
    <svg
      width="148"
      height="120"
      viewBox="0 0 148 120"
      fill="none"
      aria-hidden="true"
      className="text-accent [@media(orientation:landscape)_and_(max-height:520px)]:hidden"
    >
      <defs>
        <linearGradient id="autoFill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.04" />
        </linearGradient>
        <linearGradient id="autoRing" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.4" />
        </linearGradient>
      </defs>
      {/* connector lines from clock to nodes */}
      <path
        d="M96 60 H120 M120 60 V36 M120 60 V84"
        stroke="var(--accent)"
        strokeOpacity="0.35"
        strokeWidth="2"
        strokeLinecap="round"
      />
      {/* clock dial */}
      <circle cx="60" cy="60" r="34" fill="url(#autoFill)" />
      <circle
        cx="60"
        cy="60"
        r="34"
        stroke="url(#autoRing)"
        strokeWidth="2.5"
      />
      {/* clock hands */}
      <path
        d="M60 60 V40 M60 60 L74 68"
        stroke="var(--accent)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="60" cy="60" r="3.5" fill="var(--accent)" />
      {/* tick marks */}
      <g
        stroke="var(--accent)"
        strokeOpacity="0.5"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M60 30 V34" />
        <path d="M60 86 V90" />
        <path d="M30 60 H34" />
        <path d="M86 60 H90" />
      </g>
      {/* workflow nodes */}
      <g>
        <rect
          x="108"
          y="26"
          width="20"
          height="20"
          rx="5"
          fill="url(#autoFill)"
          stroke="url(#autoRing)"
          strokeWidth="2"
        />
        <rect
          x="108"
          y="74"
          width="20"
          height="20"
          rx="5"
          fill="url(#autoFill)"
          stroke="url(#autoRing)"
          strokeWidth="2"
        />
      </g>
    </svg>
  );
}

function WorkflowEditorLoader({
  workflowId,
  onSaved,
  onCancel,
}: {
  workflowId: string | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  // A null workflowId means "create new" — resolve to a null definition
  // without hitting the API. Otherwise fetch the definition to edit.
  const fetchState = useFetchData<WorkflowDefinition | null>(
    async () => (workflowId ? client.getWorkflowDefinition(workflowId) : null),
    [workflowId],
  );

  if (fetchState.status === "error") {
    return (
      <div className="p-6">
        <div className="rounded-sm border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
          {fetchState.error.message ||
            t("automationsfeed.workflowLoadError", {
              defaultValue: "Failed to load workflow.",
            })}
        </div>
        <Button variant="ghost" size="sm" className="mt-3" onClick={onCancel}>
          {t("automationsfeed.back", { defaultValue: "Back" })}
        </Button>
      </div>
    );
  }
  if (fetchState.status !== "success") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Spinner className="size-5" />
      </div>
    );
  }
  return (
    <div className="device-layout mx-auto flex h-full w-full max-w-7xl flex-col gap-4 px-4 pt-[var(--view-pad-top)] pb-[var(--view-pad-bottom)] lg:px-6">
      <WorkflowEditor
        initial={fetchState.data}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    </div>
  );
}
