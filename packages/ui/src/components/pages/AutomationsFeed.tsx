/**
 * AutomationsFeed — focused, single-screen list of every automation
 * (tasks AND workflows) with the same row format. Click a row to open
 * the matching editor (TaskEditor or WorkflowEditor).
 *
 * This component is intentionally separate from the existing
 * `AutomationsView` — that surface is the full dashboard with sidebar
 * chat, palette, node catalog, etc. This is the visual feed for users who
 * just want to see what's running.
 *
 * Backend: the list is fetched from `GET /api/automations` (served by
 * `@elizaos/plugin-workflow`), which already aggregates workbench tasks,
 * triggers, and workflows into one `AutomationListResponse`. Editing routes
 * through the workflow CRUD endpoints under `/api/workflow/*`.
 */

import {
  CalendarClock,
  CheckCircle2,
  CircleSlash,
  Clock,
  History,
  Layers,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Workflow,
  Zap,
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
import { getCached, setCached } from "../../hooks/resource-cache";
import { useAutomationDeepLink } from "../../hooks/useAutomationDeepLink";
import { useFetchData } from "../../hooks/useFetchData";
import { useTranslation } from "../../state/TranslationContext.hooks";
import {
  type FeedFilter,
  passesFilter,
} from "../../utils/automation-feed-filter";
import { formatSchedule } from "../../utils/cron-format";
import { decodeScheduleTags } from "../../utils/task-schedule";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { ListSkeleton } from "../ui/skeleton-layouts";
import { Spinner } from "../ui/spinner";
import { StatusBadge } from "../ui/status-badge";
import { ShellViewAgentSurface } from "../views/ShellViewAgentSurface";
import { TaskEditor } from "./TaskEditor";
import { WorkflowEditor } from "./WorkflowEditor";
import {
  VISUALIZE_WORKFLOW_EVENT,
  type VisualizeWorkflowEventDetail,
} from "./workflow-graph-events";

export type { FeedFilter } from "../../utils/automation-feed-filter";

type ChooserState = "closed" | "task" | "workflow";

type EditorState =
  | { kind: "none" }
  | { kind: "task"; taskId: string | null }
  | { kind: "workflow"; workflowId: string | null };

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
    tasks: { key: "automationsfeed.filterTasks", defaultLabel: "Tasks" },
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
  tasks: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />,
  workflows: <Workflow className="h-3.5 w-3.5" aria-hidden />,
  active: <Play className="h-3.5 w-3.5" aria-hidden />,
  inactive: <CircleSlash className="h-3.5 w-3.5" aria-hidden />,
};
const NEW_AUTOMATION_LINK_ID = "__new__";

interface FeedRow {
  key: string;
  kind: "task" | "workflow";
  title: string;
  schedule: string | null;
  active: boolean;
  status: string;
  lastUpdated: string | null;
  lastRunStatus: NonNullable<AutomationItem["lastExecution"]>["status"] | null;
  source: AutomationItem;
}

function automationToRow(
  item: AutomationItem,
  t: ReturnType<typeof useTranslation>["t"],
): FeedRow {
  const isWorkflow = item.type === "workflow";
  const schedule = isWorkflow
    ? item.schedules
        .map((trigger) => {
          if (trigger.cronExpression)
            return formatSchedule(trigger.cronExpression);
          if (trigger.displayName) return trigger.displayName;
          return null;
        })
        .filter((s): s is string => Boolean(s))
        .join(", ") || null
    : (() => {
        const decoded = decodeScheduleTags(item.task?.tags);
        if (decoded.kind === "recurring" && decoded.cronExpression) {
          return formatSchedule(decoded.cronExpression);
        }
        if (decoded.kind === "event" && decoded.eventName) {
          return t("automationsfeed.onEvent", {
            event: decoded.eventName,
            defaultValue: "On {{event}}",
          });
        }
        return null;
      })();

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
  const [chooser, setChooser] = useState<ChooserState>("closed");
  const { link, setLink } = useAutomationDeepLink();
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());

  const refreshAgent = useAgentElement<HTMLButtonElement>({
    id: "action-refresh",
    role: "button",
    label: t("automationsfeed.refresh", { defaultValue: "Refresh" }),
    group: "automations-actions",
    description: "Reload the list of automations",
    onActivate: () => void refresh(),
  });
  const newAgent = useAgentElement<HTMLButtonElement>({
    id: "action-new",
    role: "button",
    label: t("automationsfeed.new", { defaultValue: "New" }),
    group: "automations-actions",
    description: "Create a new automation",
    onActivate: () => setChooser("task"),
  });

  const editor: EditorState = useMemo(() => {
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
  }, [link]);

  const setEditor = useCallback(
    (next: EditorState) => {
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
        const res = await client.listAutomations();
        setData(res);
        setCached("automations:list", res);
      } catch (e) {
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

  const tasksCount = useMemo(
    () => automations.filter((a) => a.type !== "workflow").length,
    [automations],
  );
  const workflowsCount =
    typeof data?.summary?.workflowCount === "number"
      ? data.summary.workflowCount
      : automations.filter((a) => a.type === "workflow").length;

  const filterCounts = useMemo<Record<FeedFilter, number>>(
    () => ({
      all: allRows.length,
      tasks: allRows.filter((r) => r.kind === "task").length,
      workflows: allRows.filter((r) => r.kind === "workflow").length,
      active: allRows.filter((r) => r.active).length,
      inactive: allRows.filter((r) => !r.active).length,
    }),
    [allRows],
  );

  // Editor mode
  if (editor.kind === "task") {
    const existing =
      editor.taskId && data
        ? data.automations.find((a) => a.task?.id === editor.taskId)
        : null;
    const decoded = decodeScheduleTags(existing?.task?.tags);
    return (
      <TaskEditor
        initial={{
          id: existing?.task?.id,
          name: existing?.task?.name,
          prompt: existing?.task?.description,
          scheduleKind: decoded.kind,
          cronExpression: decoded.cronExpression,
          eventName: decoded.eventName,
        }}
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
          setEditor({ kind: "none" });
          void refresh();
        }}
        onCancel={() => setEditor({ kind: "none" })}
      />
    );
  }

  const feedContent = (
    <ShellViewAgentSurface viewId="automations">
      <div
        data-testid="automations-shell"
        className="device-layout mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4 lg:px-6"
      >
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-accent/30 bg-gradient-to-br from-accent/20 to-accent/5 text-accent"
              aria-hidden
            >
              <Zap className="h-5 w-5" />
            </span>
            <div className="space-y-1">
              <h1 className="text-lg font-semibold tracking-[-0.01em] text-txt">
                {t("automationsfeed.title", { defaultValue: "Automations" })}
              </h1>
              <div className="flex flex-wrap items-center gap-1.5">
                <StatChip
                  icon={<CheckCircle2 className="h-3 w-3" />}
                  count={tasksCount}
                  label={t("automationsfeed.tasksStat", {
                    defaultValue: "tasks",
                  })}
                  tone="info"
                />
                <StatChip
                  icon={<Workflow className="h-3 w-3" />}
                  count={workflowsCount}
                  label={t("automationsfeed.workflowsStat", {
                    defaultValue: "workflows",
                  })}
                  tone="accent"
                />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              ref={refreshAgent.ref}
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label={t("automationsfeed.refresh", {
                defaultValue: "Refresh",
              })}
              {...refreshAgent.agentProps}
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                aria-hidden
              />
            </Button>
            <Button
              ref={newAgent.ref}
              variant="default"
              size="sm"
              onClick={() => setChooser("task")}
              {...newAgent.agentProps}
            >
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              {t("automationsfeed.new", { defaultValue: "New" })}
            </Button>
          </div>
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

        {/* Feed */}
        <PagePanel variant="inset" className="overflow-hidden rounded-sm p-0">
          {loading && !data ? (
            <ListSkeleton rows={6} className="p-3" />
          ) : rows.length === 0 ? (
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
                    defaultValue: "Tasks and workflows you create run here.",
                  })}
                </p>
              </div>
              <Button
                variant="default"
                size="sm"
                onClick={() => setChooser("task")}
              >
                <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
                {t("automationsfeed.createFirst", {
                  defaultValue: "Create your first automation",
                })}
              </Button>
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
                  onOpen={() => {
                    if (row.kind === "task") {
                      setEditor({
                        kind: "task",
                        taskId: row.source.task?.id ?? null,
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
                      await client.activateWorkflowDefinition(
                        row.source.workflowId,
                      );
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

        {/* Chooser */}
        {chooser !== "closed" && (
          <ChooserSheet
            onChooseTask={() => {
              setChooser("closed");
              setEditor({ kind: "task", taskId: null });
            }}
            onChooseWorkflow={() => {
              setChooser("closed");
              setEditor({ kind: "workflow", workflowId: null });
            }}
            onClose={() => setChooser("closed")}
          />
        )}
      </div>
    </ShellViewAgentSurface>
  );

  return feedContent;
}

function StatChip({
  icon,
  count,
  label,
  tone,
}: {
  icon: ReactNode;
  count: number;
  label: string;
  tone: "accent" | "info";
}) {
  const toneClasses =
    tone === "accent"
      ? "border-accent/25 bg-accent/10 text-accent"
      : "border-status-info/25 bg-status-info-bg text-status-info";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${toneClasses}`}
    >
      <span className="[&>svg]:h-3 [&>svg]:w-3">{icon}</span>
      <span className="tabular-nums font-semibold">{count}</span>
      <span className="text-[0.7rem] opacity-80">{label}</span>
    </span>
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
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(filter)}
      aria-current={isActive ? "true" : undefined}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors ${
        isActive
          ? "border-accent bg-accent/10 text-accent"
          : "border-border/40 text-muted-strong hover:border-border hover:bg-bg-accent/40"
      }`}
      {...agentProps}
    >
      <span className="[&>svg]:h-3.5 [&>svg]:w-3.5">{icon}</span>
      <span>{label}</span>
      <span
        className={`min-w-4 rounded-full px-1 text-center text-[0.65rem] font-semibold tabular-nums ${
          isActive
            ? "bg-accent/20 text-accent"
            : "bg-bg-accent text-muted-strong"
        }`}
      >
        {count}
      </span>
    </button>
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
  const medallionClasses = isWorkflow
    ? "border-accent/30 bg-gradient-to-br from-accent/20 to-accent/5 text-accent"
    : "border-status-info/30 bg-gradient-to-br from-status-info-bg to-transparent text-status-info";
  return (
    <li
      ref={registerRef}
      className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-bg-accent/40"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border ${medallionClasses}`}
          aria-hidden
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-txt">
              {row.title}
            </span>
            <StatusBadge
              withDot
              tone={row.active ? "success" : "muted"}
              label={
                row.active
                  ? t("automationsfeed.active", { defaultValue: "Active" })
                  : t("automationsfeed.inactive", { defaultValue: "Inactive" })
              }
            />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-strong">
            <RowChip
              icon={
                isWorkflow ? (
                  <Workflow className="h-3 w-3" />
                ) : (
                  <CheckCircle2 className="h-3 w-3" />
                )
              }
              label={
                isWorkflow
                  ? t("automationsfeed.workflow", { defaultValue: "Workflow" })
                  : t("automationsfeed.task", { defaultValue: "Task" })
              }
            />
            {row.schedule && (
              <RowChip
                icon={<CalendarClock className="h-3 w-3" />}
                label={row.schedule}
                tone="accent"
              />
            )}
            {row.lastRunStatus && (
              <RowChip
                icon={<History className="h-3 w-3" />}
                label={t(`automationsfeed.run.${row.lastRunStatus}`, {
                  defaultValue: row.lastRunStatus,
                })}
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
      </button>
      {row.kind === "workflow" && (
        <button
          type="button"
          aria-label={
            row.active
              ? t("automationsfeed.deactivateWorkflow", {
                  defaultValue: "Deactivate workflow",
                })
              : t("automationsfeed.activateWorkflow", {
                  defaultValue: "Activate workflow",
                })
          }
          onClick={onRunNow}
          className="rounded-sm border border-border/40 px-2 py-1 text-xs text-muted-strong opacity-0 transition-opacity hover:border-border group-hover:opacity-100 focus:opacity-100"
        >
          {row.active ? (
            <Pause className="h-3 w-3" aria-hidden />
          ) : (
            <Play className="h-3 w-3" aria-hidden />
          )}
        </button>
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
    muted: "border-border/40 bg-bg-accent/40 text-muted-strong",
    accent: "border-accent/25 bg-accent/10 text-accent",
    success: "border-ok/30 bg-ok/10 text-ok",
    danger: "border-destructive/30 bg-destructive/10 text-destructive",
  }[tone];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 ${toneClasses}`}
    >
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

function ChooserSheet({
  onChooseTask,
  onChooseWorkflow,
  onClose,
}: {
  onChooseTask: () => void;
  onChooseWorkflow: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 lg:items-center">
      <button
        type="button"
        aria-label={t("automationsfeed.close", { defaultValue: "Close" })}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <dialog
        open
        className="relative m-0 w-full max-w-md rounded-sm border border-border/40 bg-bg p-4 "
        aria-modal="true"
      >
        <h3 className="mb-3 text-base font-semibold text-txt">
          {t("automationsfeed.chooserTitle", {
            defaultValue: "What do you want to create?",
          })}
        </h3>
        <div className="grid gap-2">
          <button
            type="button"
            onClick={onChooseTask}
            className="flex items-start gap-3 rounded-sm border border-border/40 p-3 text-left transition-colors hover:border-accent hover:bg-accent/5"
          >
            <CheckCircle2
              className="mt-0.5 h-5 w-5 shrink-0 text-status-info"
              aria-hidden
            />
            <div>
              <div className="text-sm font-medium text-txt">
                {t("automationsfeed.taskOption", {
                  defaultValue: "Task (simple prompt)",
                })}
              </div>
              <div className="text-xs text-muted-strong">
                {t("automationsfeed.taskOptionDesc", {
                  defaultValue:
                    "One prompt, run once or on a schedule. Pick this if you're not sure.",
                })}
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={onChooseWorkflow}
            className="flex items-start gap-3 rounded-sm border border-border/40 p-3 text-left transition-colors hover:border-accent hover:bg-accent/5"
          >
            <Workflow
              className="mt-0.5 h-5 w-5 shrink-0 text-accent"
              aria-hidden
            />
            <div>
              <div className="text-sm font-medium text-txt">
                {t("automationsfeed.workflowOption", {
                  defaultValue: "Workflow (node graph)",
                })}
              </div>
              <div className="text-xs text-muted-strong">
                {t("automationsfeed.workflowOptionDesc", {
                  defaultValue:
                    "Multi-step. Trigger → actions → integrations. Edit JSON or generate from a prompt.",
                })}
              </div>
            </div>
          </button>
        </div>
      </dialog>
    </div>
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
    <div className="device-layout mx-auto flex h-full w-full max-w-7xl flex-col gap-4 px-4 py-4 lg:px-6">
      <WorkflowEditor
        initial={fetchState.data}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    </div>
  );
}
