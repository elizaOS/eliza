/**
 * AutomationsFeed — focused, single-screen list of every automation
 * (tasks AND workflows) with the same row format. Click a row to open
 * the matching editor (TaskEditor or WorkflowEditor).
 *
 * This component is intentionally separate from the existing
 * `AutomationsView` — that surface is the full dashboard with sidebar
 * chat, palette, node catalog, etc. This is the "obvious nobody thinks
 * about it" feed for users who just want to see what's running.
 *
 * Backend dependencies:
 *   GET  /api/automations          (existing)
 *   GET  /api/workbench/tasks      (existing, via WorkbenchTask types)
 *   POST /api/workbench/tasks      (existing)
 *   POST /api/workflow/workflows   (existing)
 *   POST /api/workflow/workflows/generate  (existing)
 *   POST /api/workflow/workflows/:id/activate (existing)
 *
 * No backend changes are required.
 */

import { Button } from "../ui/button";
import { PagePanel } from "../composites/page-panel";
import { Spinner } from "../ui/spinner";
import { StatusBadge } from "../ui/status-badge";
import {
  Calendar,
  CheckCircle2,
  ChevronRight,
  ListChecks,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../api";
import type {
  AutomationItem,
  AutomationListResponse,
} from "../../api/client-types-config";
import { useAutomationDeepLink } from "../../hooks/useAutomationDeepLink";
import {
  type FeedFilter,
  passesFilter,
} from "../../utils/automation-feed-filter";
import { formatSchedule } from "../../utils/cron-format";
import { decodeScheduleTags } from "../../utils/task-schedule";
import { AutomationsChatPane } from "./AutomationsChatPane";
import { TaskEditor } from "./TaskEditor";
import { WorkflowEditor } from "./WorkflowEditor";
import {
  VISUALIZE_WORKFLOW_EVENT,
  type VisualizeWorkflowEventDetail,
} from "./workflow-graph-events";

export type { FeedFilter } from "../../utils/automation-feed-filter";
export { passesFilter } from "../../utils/automation-feed-filter";

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
  /**
   * Render the in-shell chat sidebar. Default: false (host opts in).
   * Hidden on narrow viewports via the layout regardless.
   */
  showChatPane?: boolean;
}

const FILTER_LABELS: Record<FeedFilter, string> = {
  all: "All",
  tasks: "Tasks",
  workflows: "Workflows",
  active: "Active",
  inactive: "Inactive",
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
  source: AutomationItem;
}

function automationToRow(item: AutomationItem): FeedRow {
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
          return `On ${decoded.eventName}`;
        }
        return null;
      })();

  return {
    key: item.id,
    kind: isWorkflow ? "workflow" : "task",
    title: item.title || "Untitled",
    schedule,
    active: item.enabled,
    status: item.status,
    lastUpdated: item.updatedAt,
    source: item,
  };
}

export function AutomationsFeed({
  connectedCredTypes,
  showChatPane = false,
}: AutomationsFeedProps = {}) {
  const [data, setData] = useState<AutomationListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FeedFilter>("all");
  const [chooser, setChooser] = useState<ChooserState>("closed");
  const { link, setLink } = useAutomationDeepLink();
  const [chatOpen, setChatOpen] = useState(showChatPane);
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map());

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

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.listAutomations();
      setData(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load automations.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
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

  const rows = useMemo(() => {
    return automations
      .map(automationToRow)
      .filter((r) => passesFilter(r, filter));
  }, [automations, filter]);

  const tasksCount = useMemo(
    () => automations.filter((a) => a.type !== "workflow").length,
    [automations],
  );
  const workflowsCount =
    typeof data?.summary?.workflowCount === "number"
      ? data.summary.workflowCount
      : automations.filter((a) => a.type === "workflow").length;

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
    <div
      data-testid="automations-shell"
      className={`device-layout mx-auto flex w-full ${chatOpen ? "max-w-3xl" : "max-w-5xl"} flex-col gap-4 px-4 py-4 lg:px-6`}
    >
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1.5">
          <h1 className="text-lg font-semibold tracking-[-0.01em] text-txt">
            Automations
          </h1>
          <p className="text-sm text-muted-strong">
            {tasksCount} task{tasksCount === 1 ? "" : "s"} · {workflowsCount}{" "}
            workflow{workflowsCount === 1 ? "" : "s"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setChatOpen((v) => !v)}
            aria-label={chatOpen ? "Hide chat" : "Show chat"}
            data-testid="automations-feed-chat-toggle"
          >
            <MessageSquare className="h-3.5 w-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={loading}
            aria-label="Refresh"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
              aria-hidden
            />
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => setChooser("task")}
          >
            <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
            New
          </Button>
        </div>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(FILTER_LABELS) as FeedFilter[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`rounded-full border px-3 py-1 text-xs transition-colors ${
              filter === key
                ? "border-accent bg-accent/10 text-accent"
                : "border-border/40 text-muted-strong hover:border-border"
            }`}
          >
            {FILTER_LABELS[key]}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Feed */}
      <PagePanel variant="inset" className="overflow-hidden rounded-2xl p-0">
        {loading && !data ? (
          <div className="flex items-center justify-center p-8">
            <Spinner className="h-5 w-5" />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 p-10 text-center text-sm text-muted-strong">
            <ListChecks className="h-6 w-6" aria-hidden />
            <div>No automations yet.</div>
            <Button
              variant="default"
              size="sm"
              onClick={() => setChooser("task")}
            >
              <Plus className="mr-1 h-3.5 w-3.5" aria-hidden />
              Create your first automation
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
                  if (row.kind !== "workflow" || !row.source.workflowId) return;
                  try {
                    await client.activateWorkflowDefinition(
                      row.source.workflowId,
                    );
                    await refresh();
                  } catch {
                    /* error surfaced on next refresh */
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
  );

  if (!chatOpen) return feedContent;
  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="min-w-0 flex-1 overflow-y-auto">{feedContent}</div>
      <aside
        className="hidden w-[360px] shrink-0 border-l border-border/40 bg-bg/40 lg:block"
        data-testid="automations-feed-chat-pane"
      >
        <div className="flex items-center justify-between border-b border-border/30 px-3 py-2 text-xs font-medium text-txt">
          <span>Ask the agent</span>
          <button
            type="button"
            onClick={() => setChatOpen(false)}
            className="text-muted-strong hover:text-txt"
            aria-label="Collapse chat"
          >
            <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
        <AutomationsChatPane className="h-[calc(100%-37px)]" />
      </aside>
    </div>
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
  const Icon = row.kind === "workflow" ? Workflow : CheckCircle2;
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
        <Icon
          className={`h-4 w-4 shrink-0 ${row.kind === "workflow" ? "text-violet-400" : "text-blue-400"}`}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium text-txt">
              {row.title}
            </span>
            <StatusBadge
              tone="muted"
              label={row.kind === "workflow" ? "Workflow" : "Task"}
            />
            {row.active ? (
              <StatusBadge tone="success" label="Active" />
            ) : (
              <StatusBadge tone="muted" label="Inactive" />
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-strong">
            {row.schedule && (
              <span className="inline-flex items-center gap-1">
                <Calendar className="h-3 w-3" aria-hidden />
                {row.schedule}
              </span>
            )}
            {row.lastUpdated && (
              <span>
                Updated{" "}
                {new Date(row.lastUpdated).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            )}
          </div>
        </div>
      </button>
      {row.kind === "workflow" && (
        <button
          type="button"
          aria-label={row.active ? "Deactivate workflow" : "Activate workflow"}
          onClick={onRunNow}
          className="rounded-md border border-border/40 px-2 py-1 text-xs text-muted-strong opacity-0 transition-opacity hover:border-border group-hover:opacity-100 focus:opacity-100"
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

function ChooserSheet({
  onChooseTask,
  onChooseWorkflow,
  onClose,
}: {
  onChooseTask: () => void;
  onChooseWorkflow: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 lg:items-center">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <dialog
        open
        className="relative m-0 w-full max-w-md rounded-2xl border border-border/40 bg-bg p-4 shadow-xl"
        aria-modal="true"
      >
        <h3 className="mb-3 text-base font-semibold text-txt">
          What do you want to create?
        </h3>
        <div className="grid gap-2">
          <button
            type="button"
            onClick={onChooseTask}
            className="flex items-start gap-3 rounded-xl border border-border/40 p-3 text-left transition-colors hover:border-accent hover:bg-accent/5"
          >
            <CheckCircle2
              className="mt-0.5 h-5 w-5 shrink-0 text-blue-400"
              aria-hidden
            />
            <div>
              <div className="text-sm font-medium text-txt">
                Task (simple prompt)
              </div>
              <div className="text-xs text-muted-strong">
                One prompt, run once or on a schedule. Pick this if you're not
                sure.
              </div>
            </div>
          </button>
          <button
            type="button"
            onClick={onChooseWorkflow}
            className="flex items-start gap-3 rounded-xl border border-border/40 p-3 text-left transition-colors hover:border-accent hover:bg-accent/5"
          >
            <Workflow
              className="mt-0.5 h-5 w-5 shrink-0 text-violet-400"
              aria-hidden
            />
            <div>
              <div className="text-sm font-medium text-txt">
                Workflow (node graph)
              </div>
              <div className="text-xs text-muted-strong">
                Multi-step. Trigger → actions → integrations. Edit JSON or
                generate from a prompt.
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
  const [loaded, setLoaded] = useState<null | {
    workflow: import("../../api/client-types-chat").WorkflowDefinition | null;
  }>(workflowId ? null : { workflow: null });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId) {
      setLoaded({ workflow: null });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const wf = await client.getWorkflowDefinition(workflowId);
        if (!cancelled) setLoaded({ workflow: wf });
      } catch (e) {
        if (!cancelled) {
          setLoadError(
            e instanceof Error ? e.message : "Failed to load workflow.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workflowId]);

  if (loadError) {
    return (
      <div className="p-6">
        <div className="rounded-lg border border-danger/20 bg-danger/10 p-3 text-sm text-danger">
          {loadError}
        </div>
        <Button variant="ghost" size="sm" className="mt-3" onClick={onCancel}>
          Back
        </Button>
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }
  return (
    <div className="device-layout mx-auto flex h-full w-full max-w-7xl flex-col gap-4 px-4 py-4 lg:px-6">
      <WorkflowEditor
        initial={loaded.workflow}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    </div>
  );
}
