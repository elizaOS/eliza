/**
 * AutomationsFeed — focused, single-screen list of every automation
 * (workflows, prompt automations, and scheduled items) with the same row
 * format. Click a row to open the matching editor (WorkflowEditor,
 * TaskEditor for a prompt automation, or ScheduledTaskEditor).
 *
 * This component is intentionally separate from the existing
 * `AutomationsView` — that surface is the full dashboard with sidebar
 * chat, palette, node catalog, etc. This is the visual feed for users who
 * just want to see what's running.
 *
 * Backend: the list is fetched from `GET /api/automations` (served by
 * `@elizaos/plugin-workflow`), which already aggregates workbench prompt
 * automations, triggers, and workflows into one `AutomationListResponse`.
 * Editing routes through the workflow CRUD endpoints under `/api/workflow/*`.
 */

import {
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  Clock,
  History,
  Layers,
  Play,
  PlayCircle,
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
import { getCached, setCached } from "../../hooks/resource-cache";
import { useAutomationDeepLink } from "../../hooks/useAutomationDeepLink";
import { useFetchData } from "../../hooks/useFetchData";
import { useTranslation } from "../../state/TranslationContext.hooks";
import {
  type FeedFilter,
  passesFilter,
} from "../../utils/automation-feed-filter";
import { formatSchedule } from "../../utils/cron-format";
import { mergeUnifiedTasks } from "../../utils/merge-unified-tasks";
import { PagePanel } from "../composites/page-panel";
import { ViewHeader } from "../shared/ViewHeader";
import { Button } from "../ui/button";
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
const FILTER_ICONS: Record<FeedFilter, ReactNode> = {
  all: <Layers className="h-3.5 w-3.5" aria-hidden />,
  prompts: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />,
  workflows: <Workflow className="h-3.5 w-3.5" aria-hidden />,
  active: <Play className="h-3.5 w-3.5" aria-hidden />,
  inactive: <CircleSlash className="h-3.5 w-3.5" aria-hidden />,
};
const NEW_AUTOMATION_LINK_ID = "__new__";

// On mobile the workflow runtime (and its `GET /api/automations` route) is
// intentionally absent — phones cannot host it — even though the Automations
// tile is registered via plugin-task-coordinator. A 404 therefore means the
// feature is unavailable, not an error, so we render the empty state instead
// of a red banner.
const EMPTY_AUTOMATIONS: AutomationListResponse = {
  automations: [],
  summary: {
    total: 0,
    coordinatorCount: 0,
    workflowCount: 0,
    scheduledCount: 0,
    draftCount: 0,
  },
  workflowStatus: null,
  workflowFetchError: null,
};

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
    source: item,
  };
}

export function AutomationsFeed({
  connectedCredTypes,
}: AutomationsFeedProps = {}) {
  const { t } = useTranslation();
  // Seed from the shared cache so a revisit paints the last-known automations
  // instantly and revalidates silently, instead of flashing a spinner.
  const cachedAutomations =
    getCached<AutomationListResponse>("automations:list");
  const [data, setData] = useState<AutomationListResponse | null>(
    cachedAutomations?.data ?? null,
  );
  const [loading, setLoading] = useState(!cachedAutomations);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FeedFilter>("all");
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
      if (!options?.silent) setLoading(true);
      setError(null);
      try {
        // Unified read: automations (workflows + workbench tasks + triggers)
        // merged client-side with LifeOps scheduled tasks. The scheduled-task
        // fetch degrades to empty where the runner isn't hosted, so a missing
        // LifeOps surface never breaks the automations list.
        const [res, scheduled] = await Promise.all([
          client.listAutomations(),
          client
            .listScheduledTasks({ ownerVisibleOnly: true })
            .catch(() => ({ tasks: [] })),
        ]);
        const merged: AutomationListResponse = {
          ...res,
          automations: mergeUnifiedTasks(res.automations, scheduled.tasks),
        };
        setData(merged);
        setCached("automations:list", merged);
      } catch (e) {
        // A 404 means the workflow runtime isn't hosted here (e.g. mobile) —
        // render the clean empty state, not an error banner. Any other failure
        // is surfaced so a broken endpoint doesn't masquerade as "no automations".
        if (isApiError(e) && e.status === 404) {
          setData(EMPTY_AUTOMATIONS);
          return;
        }
        setError(
          e instanceof Error
            ? e.message
            : t("automationsfeed.loadError", {
                defaultValue: "Failed to load automations.",
              }),
        );
      } finally {
        setLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    // Revalidate silently when cached automations are already on screen.
    void refresh({ silent: getCached("automations:list") != null });
  }, [refresh]);

  const automations = useMemo(
    () => (Array.isArray(data?.automations) ? data.automations : []),
    [data],
  );

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

  const overviewStats = useMemo(
    () => [
      {
        key: "total",
        label: t("automationsfeed.statTotal", { defaultValue: "Total" }),
        value: allRows.length,
      },
      {
        key: "active",
        label: t("automationsfeed.statActive", { defaultValue: "Active" }),
        value: filterCounts.active,
      },
      {
        key: "passed",
        label: t("automationsfeed.statPassed", { defaultValue: "Passed" }),
        value: allRows.filter((row) => row.lastRunStatus === "success").length,
      },
      {
        key: "failed",
        label: t("automationsfeed.statFailed", { defaultValue: "Failed" }),
        value: allRows.filter((row) => row.lastRunStatus === "error").length,
      },
    ],
    [allRows, filterCounts.active, t],
  );

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

  const feedContent = (
    <ShellViewAgentSurface viewId="automations">
      {/* Uniform view header (#13451/#13597): bare-icon back, centered title. */}
      <ViewHeader
        title={t("automationsfeed.title", { defaultValue: "Automations" })}
      />
      {/* Flat — no card/border. The shell owns the page's horizontal padding. */}
      <div
        data-testid="automations-shell"
        className="device-layout mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 pt-[var(--view-pad-top)] pb-[var(--view-pad-bottom)] lg:px-6"
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {overviewStats.map((stat) => (
            <OverviewStat
              key={stat.key}
              statKey={stat.key}
              label={stat.label}
              value={stat.value}
            />
          ))}
        </div>

        {/* Filter chips */}
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(FILTER_LABELS) as FeedFilter[]).map((key) => (
            <FilterChipButton
              key={key}
              filter={key}
              label={t(FILTER_LABELS[key].key, {
                defaultValue: FILTER_LABELS[key].defaultLabel,
              })}
              icon={FILTER_ICONS[key]}
              count={filterCounts[key]}
              isActive={filter === key}
              onSelect={setFilter}
            />
          ))}
        </div>

        {error && (
          <div className="rounded-sm border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </div>
        )}

        {/* Feed — flat, no card/border; rows separate by whitespace. */}
        <PagePanel variant="inset" className="p-0">
          {loading && !data ? (
            <ListSkeleton rows={6} className="p-3" />
          ) : rows.length === 0 ? (
            // Designed-empty render only. A default workflow is seeded on first
            // run so this state is unreachable in practice (#13597); it exists
            // for the deleted-everything edge. NO create CTA — the agent offers
            // to re-create a workflow from chat instead.
            <div className="flex flex-col items-center gap-5 px-6 py-14 text-center">
              <AutomationEmptyIllustration />
              <div className="space-y-1">
                <p className="text-sm font-medium text-txt">
                  {t("automationsfeed.emptyHeadline", {
                    defaultValue: "Nothing scheduled yet",
                  })}
                </p>
                <p className="text-xs text-muted-strong">
                  {t("automationsfeed.emptySub", {
                    defaultValue:
                      "Ask in chat to set up a workflow and it will run here.",
                  })}
                </p>
              </div>
            </div>
          ) : (
            <ul>
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
                          row.source.task?.id ?? row.source.triggerId ?? null,
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
                    try {
                      await client.runWorkflowDefinition(row.source.workflowId);
                      await refresh();
                    } catch (e) {
                      setError(
                        e instanceof Error
                          ? e.message
                          : t("automationsfeed.runError", {
                              defaultValue: "Failed to run automation.",
                            }),
                      );
                    }
                  }}
                />
              ))}
            </ul>
          )}
        </PagePanel>
      </div>
    </ShellViewAgentSurface>
  );

  return feedContent;
}

function OverviewStat({
  statKey,
  label,
  value,
}: {
  statKey: string;
  label: string;
  value: number;
}) {
  return (
    // Flat — no card border/fill (#10710, "no card chrome"): the grid gap +
    // label/value type hierarchy group the stats; the surrounding surface shows
    // through, matching the minimal eliza aesthetic (cf. SettingsView flat rows).
    <div className="py-1" data-testid={`automation-stat-${statKey}`}>
      <div className="text-2xs font-medium uppercase tracking-normal text-muted-strong">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold leading-none tabular-nums text-txt">
        {value}
      </div>
    </div>
  );
}

function FilterChipButton({
  filter,
  label,
  icon,
  count,
  isActive,
  onSelect,
}: {
  filter: FeedFilter;
  label: string;
  icon: ReactNode;
  count: number;
  isActive: boolean;
  onSelect: (filter: FeedFilter) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tab-${filter}`,
    role: "tab",
    label,
    group: "automations-filters",
    status: isActive ? "active" : "inactive",
    description: `Filter automations to "${label}"`,
    onActivate: () => onSelect(filter),
  });
  return (
    <Button
      ref={ref}
      onClick={() => onSelect(filter)}
      aria-current={isActive ? "true" : undefined}
      variant="ghost"
      size="sm"
      // Borderless text tab (#10710): active reads as accent text on a faint
      // wash; the count renders as plain text and hides at zero.
      className={`h-auto gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
        isActive
          ? "bg-accent/10 text-accent"
          : "text-muted-strong hover:bg-bg-accent/40"
      }`}
      {...agentProps}
    >
      <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      <span>{label}</span>
      {count > 0 ? (
        <span className="text-[0.65rem] font-semibold tabular-nums">
          {count}
        </span>
      ) : null}
    </Button>
  );
}

function FeedRowItem({
  row,
  onOpen,
  onRunNow,
  connectedCredTypes: _connectedCredTypes,
  registerRef,
}: {
  row: FeedRow;
  onOpen: () => void;
  onRunNow: () => void;
  connectedCredTypes?: ReadonlySet<string>;
  registerRef?: (el: HTMLLIElement | null) => void;
}) {
  const { t } = useTranslation();
  const isWorkflow = row.kind === "workflow";
  const Icon = isWorkflow ? Workflow : CheckCircle2;
  const iconToneClass = isWorkflow ? "text-accent" : "text-muted-strong";
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
      row.lastRunStatus === "running" || row.lastRunStatus === "waiting"
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
      className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-bg-accent/40"
    >
      <Button
        ref={openAction.ref}
        onClick={onOpen}
        variant="ghost"
        className="flex h-auto min-w-0 flex-1 items-center justify-start gap-3 whitespace-normal rounded-none p-0 text-left font-normal hover:bg-transparent"
        {...openAction.agentProps}
      >
        <Icon className={`h-4 w-4 shrink-0 ${iconToneClass}`} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-txt">
              {row.title}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 text-xs ${
                row.active ? "text-ok" : "text-muted-strong"
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
                icon={<CalendarClock className="h-3 w-3" />}
                label={row.schedule}
                tone="accent"
              />
            )}
            {lastRunLabel && row.lastRunStatus && (
              <RowChip
                icon={<History className="h-3 w-3" />}
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
            {!row.schedule && row.lastUpdated && (
              <RowChip
                icon={<Clock className="h-3 w-3" />}
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
          onClick={onRunNow}
          variant="ghost"
          size="icon-sm"
          className="h-7 w-7 rounded-sm p-1.5 text-muted-strong transition-colors hover:bg-bg-accent"
          {...runAction.agentProps}
        >
          <PlayCircle className="h-3.5 w-3.5" aria-hidden />
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
    accent: "text-accent",
    success: "text-ok",
    danger: "text-destructive",
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
      className="text-accent"
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
        <Spinner className="h-5 w-5" />
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
