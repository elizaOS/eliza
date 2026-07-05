// Direct subpath: the app renderer resolves the bare `@elizaos/ui` root to the
// browser barrel, which doesn't reliably re-export this newer component.
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Button,
  type ChangeSetData,
  type CodingAgentAddAgentInput,
  type CodingAgentOrchestratorStatus,
  type CodingAgentRerunFromEventInput,
  type CodingAgentRestartWithEditedPlanInput,
  type CodingAgentRetryTurnInput,
  type CodingAgentTaskArtifactRecord,
  type CodingAgentTaskEventRecord,
  type CodingAgentTaskMessageRecord,
  type CodingAgentTaskSessionRecord,
  type CodingAgentTaskThread,
  type CodingAgentTaskThreadDetail,
  type CodingAgentTaskUsageSummary,
  client,
  DiffReviewPanel,
  useAppSelectorShallow,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Input } from "@elizaos/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@elizaos/ui/components/ui/select";
import { Textarea } from "@elizaos/ui/components/ui/textarea";
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronsUp,
  ChevronUp,
  CircleStop,
  Copy,
  Gauge,
  GitFork,
  Layers,
  PanelRightOpen,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type UIEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { OrchestratorAccountHealthPanel } from "./OrchestratorAccountHealthPanel";
import { paramPriority, type TaskPriority } from "./orchestrator-params";
import {
  type ConversationBlock,
  ConversationBlockView,
  ToolBody,
} from "./orchestrator-stream";
import { buildConversation } from "./orchestrator-stream.helpers";
import {
  FILTER_OPTIONS,
  fallbackTranslate,
  labelPriority,
  labelStatus,
  PlanStepGlyph,
  PRIORITY_ICON,
  resolveSenderName,
  SessionGlyph,
  type StatusFilter,
  StatusGlyph,
  TERMINAL_TASK_STATUSES,
  type Translate,
  VerificationGlyph,
} from "./orchestrator-workbench-glyphs";
import {
  BackChip,
  SparseWatermark,
  TaskCard,
  TaskEmptyState,
  TaskMetaChip,
  TaskSearchInput,
  TaskStatusChip,
} from "./TaskCardList";
import { useOrchestratorData } from "./use-orchestrator-data";
import {
  formatClockTime,
  formatCompactNumber,
  formatDuration,
  formatIsoRelative,
  formatRelativeTime,
  formatUsd,
} from "./view-format";

type OperatorTab = "input" | "output" | "events" | "usage";
type DetailDrawerSelection =
  | { kind: "session"; sessionId: string }
  | {
      kind: "block";
      blockKey: string;
      blockKind: ConversationBlock["kind"];
      eventIds: string[];
      messageIds: string[];
    };

interface NormalizedPlan {
  summary: string | null;
  /** `key` is the step's ordinal identity within this plan snapshot (plans are
   * ordered and steps carry no server id), used for stable React keys. */
  steps: { key: string; label: string; status: string | null }[];
}

/** Adapt the free-form `currentPlan` record into a renderable shape, or null
 * when it carries no recognizable summary/steps (so we never dump raw JSON). */
function normalizePlan(
  plan: Record<string, unknown> | null,
): NormalizedPlan | null {
  if (!plan) return null;
  const summary = typeof plan.summary === "string" ? plan.summary : null;
  const rawSteps = Array.isArray(plan.steps) ? plan.steps : [];
  const steps: NormalizedPlan["steps"] = [];
  for (const raw of rawSteps) {
    if (typeof raw === "string" && raw.trim()) {
      steps.push({
        key: `step-${steps.length}`,
        label: raw.trim(),
        status: null,
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
      steps.push({
        key: `step-${steps.length}`,
        label,
        status: typeof obj.status === "string" ? obj.status : null,
      });
    }
  }
  if (!summary && steps.length === 0) return null;
  return { summary, steps };
}

// --- Usage rendering -------------------------------------------------------
// Token/cost figures are computed server-side. The client only formats them and
// honors `state` so "unavailable" never renders as a misleading confident zero.

type UsageState = "measured" | "estimated" | "unavailable";

// Shared token formatter so every surface (header, inspector total, per-provider
// breakdown, sub-agent cards) renders the same `~` estimated prefix and `—`
// unavailable marker instead of a misleading confident number.
function formatTokenCount(
  state: UsageState,
  totalTokens: number,
  t: Translate,
  locale?: string,
): string {
  if (state === "unavailable") {
    return t("orchestrator.usage.unavailable", { defaultValue: "—" });
  }
  const value = formatCompactNumber(totalTokens, locale);
  return state === "estimated"
    ? t("orchestrator.usage.estimatedTokens", {
        defaultValue: "~{{value}}",
        value,
      })
    : value;
}

function renderTokens(
  usage: CodingAgentTaskUsageSummary,
  t: Translate,
  locale?: string,
): string {
  return formatTokenCount(usage.state, usage.totalTokens, t, locale);
}

function renderCost(
  usage: CodingAgentTaskUsageSummary,
  t: Translate,
  locale?: string,
): string {
  if (usage.state === "unavailable") {
    return t("orchestrator.usage.unavailable", { defaultValue: "—" });
  }
  const value = formatUsd(usage.costUsd, locale);
  return usage.state === "estimated"
    ? t("orchestrator.usage.estimatedCost", {
        defaultValue: "~{{value}}",
        value,
      })
    : value;
}

/** One labeled count in the header summary — a baseline-aligned number + tiny
 * label, no pill/border. */
function HeaderStat({
  value,
  label,
  toneClass = "text-txt-strong",
}: {
  value: string;
  label: string;
  toneClass?: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-baseline gap-1" title={label}>
      <span className={`text-sm font-semibold tabular-nums ${toneClass}`}>
        {value}
      </span>
      <span className="text-2xs text-muted">{label}</span>
    </span>
  );
}

/** Borderless inspector section separated by whitespace alone. */
function InspectorSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function WorkbenchHeader({
  status,
  busy,
  isMobile,
  onPauseAll,
  onResumeAll,
  accountsOpen,
  onToggleAccounts,
  t,
  locale,
}: {
  status: CodingAgentOrchestratorStatus | null;
  busy: boolean;
  isMobile: boolean;
  onPauseAll: () => void;
  onResumeAll: () => void;
  accountsOpen: boolean;
  onToggleAccounts: () => void;
  t: Translate;
  locale?: string;
}) {
  const title = (
    <div className="flex shrink-0 items-center gap-2">
      <Layers className="h-4 w-4 text-accent" />
      <span className="text-sm font-semibold text-txt-strong">
        {t("orchestrator.title", { defaultValue: "Orchestrator" })}
      </span>
    </div>
  );
  // Calm labeled summary: total tasks always, then only the non-zero semantic
  // counts — reads "12 tasks · 1 active · 3 done", not a six-pill debug strip.
  const summary = (
    <div
      className="flex min-w-0 items-center gap-4 overflow-x-auto"
      style={isMobile ? undefined : { flex: "1 1 0%" }}
    >
      <HeaderStat value={String(status?.taskCount ?? 0)} label="tasks" />
      {status?.activeTaskCount ? (
        <HeaderStat
          value={String(status.activeTaskCount)}
          label="active"
          toneClass="text-ok"
        />
      ) : null}
      {status?.blockedTaskCount ? (
        <HeaderStat
          value={String(status.blockedTaskCount)}
          label="blocked"
          toneClass="text-warn"
        />
      ) : null}
      {status?.validatingTaskCount ? (
        <HeaderStat
          value={String(status.validatingTaskCount)}
          label="validating"
          toneClass="text-accent"
        />
      ) : null}
      {status?.activeSessionCount ? (
        <HeaderStat
          value={`${status.activeSessionCount}/${status.sessionCount}`}
          label="agents"
        />
      ) : null}
    </div>
  );
  // Only surface the usage readout once there is real spend to report. An
  // unavailable usage state renders "— · —", which looks like a debug leftover.
  const usageReadout =
    status && status.usage.state !== "unavailable" ? (
      <span
        className="flex shrink-0 items-center gap-1.5 text-xs tabular-nums text-muted"
        title={t("orchestrator.stat.usage", { defaultValue: "Usage" })}
      >
        <Gauge className="h-3 w-3 text-muted/70" />
        {renderTokens(status.usage, t, locale)}
        <span className="text-muted/50">·</span>
        {renderCost(status.usage, t, locale)}
      </span>
    ) : null;
  const pauseAllLabel = t("orchestrator.action.pauseAll", {
    defaultValue: "Pause all",
  });
  const resumeAllLabel = t("orchestrator.action.resumeAll", {
    defaultValue: "Resume all",
  });
  const { ref: pauseAllRef, agentProps: pauseAllAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "header-pause-all",
      role: "button",
      label: pauseAllLabel,
      group: "orchestrator-header",
      description: "Pause every active orchestrator task",
    });
  const { ref: resumeAllRef, agentProps: resumeAllAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "header-resume-all",
      role: "button",
      label: resumeAllLabel,
      group: "orchestrator-header",
      description: "Resume every paused orchestrator task",
    });
  const accountsLabel = t("orchestrator.toggleAccounts", {
    defaultValue: "Coding accounts & pool health",
  });
  const accountsToggle = (
    <Button
      variant="ghost"
      size="sm"
      onClick={onToggleAccounts}
      className="h-7 w-7 shrink-0 p-0"
      aria-label={accountsLabel}
      aria-pressed={accountsOpen}
      title={accountsLabel}
      data-testid="orchestrator-accounts-toggle"
    >
      <Gauge className="h-3.5 w-3.5" />
    </Button>
  );
  // Pause-all / resume-all only surface while there is something to act on, so a
  // quiet orchestrator shows no controls at all — the dashboard is read-only
  // until work is in flight. New tasks are started conversationally in chat.
  const actions =
    status?.activeTaskCount || status?.pausedTaskCount ? (
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {status?.activeTaskCount ? (
          <Button
            ref={pauseAllRef}
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onPauseAll}
            className="h-7 w-7 p-0"
            aria-label={pauseAllLabel}
            title={pauseAllLabel}
            data-testid="orchestrator-pause-all"
            {...pauseAllAgentProps}
          >
            <Pause className="h-3.5 w-3.5" />
          </Button>
        ) : null}
        {status?.pausedTaskCount ? (
          <Button
            ref={resumeAllRef}
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={onResumeAll}
            className="h-7 w-7 p-0"
            aria-label={resumeAllLabel}
            title={resumeAllLabel}
            data-testid="orchestrator-resume-all"
            {...resumeAllAgentProps}
          >
            <Play className="h-3.5 w-3.5" />
          </Button>
        ) : null}
      </div>
    ) : null;

  if (isMobile) {
    return (
      <header className="flex flex-col gap-2 bg-bg px-4 py-2.5">
        <div className="flex items-center gap-2">
          {title}
          <div className="ml-auto flex items-center gap-1.5">
            {accountsToggle}
            {actions}
          </div>
        </div>
        <div className="flex items-center justify-between gap-2">
          {summary}
          {usageReadout}
        </div>
      </header>
    );
  }

  return (
    <header className="flex items-center gap-4 bg-bg px-4 py-2.5">
      {title}
      {summary}
      {usageReadout}
      {accountsToggle}
      {actions}
    </header>
  );
}

function FilterSelect({
  status,
  active,
  onSelect,
  t,
}: {
  status: CodingAgentOrchestratorStatus | null;
  active: StatusFilter;
  onSelect: (filter: StatusFilter) => void;
  t: Translate;
}) {
  const countFor = (filter: StatusFilter): number => {
    if (!status) return 0;
    if (filter === "all") return status.taskCount;
    return status.byStatus[filter] ?? 0;
  };
  const filterLabel = t("orchestrator.filter.label", {
    defaultValue: "Filter by status",
  });
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "rail-filter-status",
    role: "select",
    label: filterLabel,
    group: "orchestrator-rail",
    description: "Filter the task list by status",
    options: FILTER_OPTIONS,
    getValue: () => active,
    onFill: (value) => {
      if ((FILTER_OPTIONS as string[]).includes(value)) {
        onSelect(value as StatusFilter);
      }
    },
  });
  const labelFor = (filter: StatusFilter) =>
    filter === "all"
      ? t("orchestrator.filter.all", { defaultValue: "All" })
      : labelStatus(filter, t);
  return (
    <Select
      value={active}
      onValueChange={(value) => onSelect(value as StatusFilter)}
    >
      <SelectTrigger
        ref={ref}
        aria-label={filterLabel}
        data-testid="orchestrator-filter"
        className="h-9 border-0 bg-transparent px-1 text-xs"
        {...agentProps}
      >
        <span className="flex items-center gap-2">
          {active !== "all" ? (
            <TaskStatusChip status={active} t={t} />
          ) : (
            <span className="text-txt">{labelFor("all")}</span>
          )}
          <span className="text-muted tabular-nums">({countFor(active)})</span>
        </span>
      </SelectTrigger>
      <SelectContent>
        {FILTER_OPTIONS.map((filter) => (
          <SelectItem key={filter} value={filter} className="text-xs">
            <span className="flex items-center gap-2">
              {filter === "all" ? (
                <span>{labelFor("all")}</span>
              ) : (
                <TaskStatusChip status={filter} t={t} />
              )}
              <span className="text-muted tabular-nums">
                ({countFor(filter)})
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Visual metadata for an orchestrator task row. */
function orchestratorTaskChips(
  thread: CodingAgentTaskThread,
  t: Translate,
  locale?: string,
): ReactNode {
  const lastActivity =
    thread.latestActivityAt != null
      ? formatRelativeTime(thread.latestActivityAt, locale)
      : formatIsoRelative(
          thread.updatedAt,
          locale,
          t("orchestrator.unknown", { defaultValue: "—" }),
        );
  const PriorityIcon = PRIORITY_ICON[thread.priority];
  return (
    <>
      {thread.sessionCount > 0 ? (
        <TaskMetaChip
          icon={<Bot className="h-3 w-3" />}
          tone={thread.activeSessionCount > 0 ? "accent" : "muted"}
        >
          {t("orchestrator.chip.agents", {
            defaultValue: "{{active}}/{{total}} agents",
            active: thread.activeSessionCount,
            total: thread.sessionCount,
          })}
        </TaskMetaChip>
      ) : null}
      {thread.paused ? (
        <TaskMetaChip icon={<Pause className="h-3 w-3" />}>
          {t("orchestrator.status.paused", { defaultValue: "Paused" })}
        </TaskMetaChip>
      ) : null}
      {PriorityIcon && thread.priority !== "normal" ? (
        <TaskMetaChip icon={<PriorityIcon className="h-3 w-3" />}>
          {labelPriority(thread.priority, t)}
        </TaskMetaChip>
      ) : null}
      <span className="text-2xs text-muted/80">{lastActivity}</span>
    </>
  );
}

function SubAgentCard({
  session,
  busy,
  onInspect,
  onStop,
  t,
  locale,
}: {
  session: CodingAgentTaskSessionRecord;
  busy: boolean;
  onInspect: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  t: Translate;
  locale?: string;
}) {
  const stoppable = session.stoppedAt == null && session.status !== "completed";
  const provider = [session.framework, session.model]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const workspace =
    session.repo ||
    session.workdir ||
    t("orchestrator.noWorkspace", { defaultValue: "None" });
  const stopLabel = t("orchestrator.action.stopAgent", {
    defaultValue: "Stop agent",
  });
  const inspectLabel = t("orchestrator.action.inspectAgent", {
    defaultValue: "Inspect agent",
  });
  const { ref: inspectRef, agentProps: inspectAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `sub-agent-inspect-${session.sessionId}`,
      role: "button",
      label: `${inspectLabel}: ${session.label}`,
      group: "orchestrator-sub-agents",
      description: `Open recovery and event details for the "${session.label}" sub-agent`,
    });
  const { ref: stopRef, agentProps: stopAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: `sub-agent-stop-${session.sessionId}`,
      role: "button",
      label: `${stopLabel}: ${session.label}`,
      group: "orchestrator-sub-agents",
      description: `Stop the "${session.label}" sub-agent`,
    });
  return (
    <div className="py-1">
      <div className="flex items-center gap-1.5">
        <SessionGlyph status={session.status} t={t} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-txt">
          {session.label}
        </span>
        <Button
          unstyled
          ref={inspectRef}
          type="button"
          onClick={() => onInspect(session.sessionId)}
          className="flex items-center gap-0.5 px-1 py-0.5 text-2xs text-muted transition-colors hover:text-txt"
          data-testid="orchestrator-inspect-session"
          aria-label={inspectLabel}
          title={inspectLabel}
          {...inspectAgentProps}
        >
          <PanelRightOpen className="h-3 w-3" />
        </Button>
        {stoppable ? (
          <Button
            unstyled
            ref={stopRef}
            type="button"
            disabled={busy}
            onClick={() => onStop(session.sessionId)}
            className="flex items-center gap-0.5 px-1 py-0.5 text-2xs text-muted transition-colors hover:text-danger disabled:opacity-50"
            data-testid="orchestrator-stop-agent"
            aria-label={stopLabel}
            {...stopAgentProps}
          >
            <CircleStop className="h-3 w-3" />
          </Button>
        ) : null}
      </div>
      {provider ? (
        <div className="mt-0.5 truncate text-2xs text-muted">{provider}</div>
      ) : null}
      <div className="mt-0.5 flex items-center gap-2 text-2xs text-muted">
        {session.activeTool ? (
          <span className="truncate text-warn">{session.activeTool}</span>
        ) : null}
        <span className="ml-auto tabular-nums">
          {formatTokenCount(session.usageState, session.totalTokens, t, locale)}
        </span>
      </div>
      <div className="mt-0.5 truncate text-2xs text-muted/80">{workspace}</div>
    </div>
  );
}

function PlanSection({ plan, t }: { plan: NormalizedPlan; t: Translate }) {
  return (
    <InspectorSection title={t("orchestrator.plan", { defaultValue: "Plan" })}>
      {plan.summary ? (
        <p className="mb-2 text-xs-tight text-txt">{plan.summary}</p>
      ) : null}
      {plan.steps.length > 0 ? (
        <ol className="space-y-1">
          {plan.steps.map((step, index) => (
            <li
              key={step.key}
              className="flex items-start gap-1.5 text-xs-tight text-txt"
            >
              <span className="mt-px shrink-0 tabular-nums text-muted">
                {index + 1}.
              </span>
              <span className="min-w-0 flex-1">{step.label}</span>
              {step.status ? (
                <PlanStepGlyph status={step.status} t={t} />
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
    </InspectorSection>
  );
}

function EditedPlanRestartSection({
  plan,
  latestPlanRevisionId,
  busy,
  onSubmit,
  t,
}: {
  plan: Record<string, unknown>;
  latestPlanRevisionId?: string;
  busy: boolean;
  onSubmit: (input: CodingAgentRestartWithEditedPlanInput) => void;
  t: Translate;
}) {
  const planSource = useMemo(() => JSON.stringify(plan, null, 2), [plan]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(planSource);
  const [summary, setSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const toggleLabel = t("orchestrator.action.editPlan", {
    defaultValue: "Edit plan",
  });
  const restartLabel = t("orchestrator.action.restartWithPlan", {
    defaultValue: "Restart with plan",
  });
  const summaryLabel = t("orchestrator.planEdit.summary", {
    defaultValue: "Edit summary",
  });
  const draftLabel = t("orchestrator.planEdit.draft", {
    defaultValue: "Plan JSON",
  });
  const baseLabel = t("orchestrator.planEdit.base", {
    defaultValue: "Base revision",
  });
  const currentPlanLabel = t("orchestrator.planEdit.currentPlan", {
    defaultValue: "Current plan",
  });
  const { ref: toggleRef, agentProps: toggleAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "inspector-plan-edit-toggle",
      role: "button",
      label: toggleLabel,
      group: "orchestrator-inspector",
      description: "Open the plan JSON editor",
    });
  const { ref: restartRef, agentProps: restartAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "inspector-restart-edited-plan",
      role: "button",
      label: restartLabel,
      group: "orchestrator-inspector",
      description: "Restart this task with the edited plan",
    });

  useEffect(() => {
    setDraft(planSource);
    setSummary("");
    setError(null);
  }, [planSource]);

  const submit = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(draft);
    } catch {
      setError(
        t("orchestrator.planEdit.invalidJson", {
          defaultValue: "Plan must be valid JSON.",
        }),
      );
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setError(
        t("orchestrator.planEdit.invalidObject", {
          defaultValue: "Plan must be a JSON object.",
        }),
      );
      return;
    }
    const confirmed =
      typeof window === "undefined" ||
      window.confirm(
        t("orchestrator.confirmRestartWithPlan", {
          defaultValue:
            "Restart this task with the edited plan? Active agents will be stopped first.",
        }),
      );
    if (!confirmed) return;
    setError(null);
    onSubmit({
      plan: parsed as Record<string, unknown>,
      basePlanRevisionId: latestPlanRevisionId,
      editSummary: summary.trim() || undefined,
      stopActive: true,
    });
  };

  return (
    <InspectorSection
      title={t("orchestrator.planEdit.title", {
        defaultValue: "Plan editor",
      })}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 text-2xs text-muted">
          <span className="font-semibold text-muted-strong">{baseLabel}</span>
          <span className="ml-1 truncate">
            {latestPlanRevisionId ?? currentPlanLabel}
          </span>
        </div>
        <Button
          unstyled
          ref={toggleRef}
          type="button"
          disabled={busy}
          onClick={() => setOpen((prev) => !prev)}
          className="inline-flex h-7 shrink-0 items-center gap-1.5 px-1 text-2xs font-semibold text-muted transition-colors hover:text-txt disabled:opacity-50"
          data-testid="orchestrator-plan-edit-toggle"
          {...toggleAgentProps}
        >
          {open ? (
            <ChevronUp className="h-3 w-3" />
          ) : (
            <ChevronDown className="h-3 w-3" />
          )}
          {toggleLabel}
        </Button>
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          <label htmlFor="orchestrator-plan-edit-summary" className="block">
            <FieldLabel>{summaryLabel}</FieldLabel>
            <Input
              id="orchestrator-plan-edit-summary"
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              className={FIELD_CLASS}
              placeholder={t("orchestrator.planEdit.summaryPlaceholder", {
                defaultValue: "What changed",
              })}
              data-testid="orchestrator-plan-edit-summary"
            />
          </label>
          <label htmlFor="orchestrator-plan-draft" className="block">
            <FieldLabel>{draftLabel}</FieldLabel>
            <Textarea
              id="orchestrator-plan-draft"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={8}
              className={`${FIELD_CLASS} resize-y font-mono leading-relaxed`}
              spellCheck={false}
              data-testid="orchestrator-plan-draft"
            />
          </label>
          {error ? <p className="text-2xs text-danger">{error}</p> : null}
          <div className="flex justify-end">
            <Button
              ref={restartRef}
              type="button"
              size="sm"
              disabled={busy}
              onClick={submit}
              className="h-7 gap-1.5 px-2.5 text-xs-tight"
              data-testid="orchestrator-plan-restart"
              {...restartAgentProps}
            >
              <RotateCcw className="h-3 w-3" />
              {restartLabel}
            </Button>
          </div>
        </div>
      ) : null}
    </InspectorSection>
  );
}

function AcceptanceSection({
  criteria,
  t,
}: {
  criteria: string[];
  t: Translate;
}) {
  return (
    <InspectorSection
      title={t("orchestrator.acceptance", { defaultValue: "Acceptance" })}
    >
      <ul className="space-y-1">
        {criteria.map((criterion, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: criteria strings may repeat, so index disambiguates the composite key
            key={`${criterion}-${index}`}
            className="flex items-start gap-1.5 text-xs-tight text-txt"
          >
            <span className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent/60" />
            <span>{criterion}</span>
          </li>
        ))}
      </ul>
    </InspectorSection>
  );
}

function ArtifactSection({
  artifacts,
  t,
}: {
  artifacts: CodingAgentTaskArtifactRecord[];
  t: Translate;
}) {
  return (
    <InspectorSection
      title={t("orchestrator.artifacts", { defaultValue: "Artifacts" })}
    >
      <div className="space-y-1.5">
        {artifacts.map((artifact) => (
          <div key={artifact.id} className="text-xs-tight">
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate font-medium text-txt">
                {artifact.title}
              </span>
              <VerificationGlyph status={artifact.verificationStatus} t={t} />
            </div>
            <div className="truncate text-muted">
              {artifact.artifactType}
              {artifact.path || artifact.uri
                ? ` · ${artifact.path ?? artifact.uri}`
                : ""}
            </div>
          </div>
        ))}
      </div>
    </InspectorSection>
  );
}

function UsageSection({
  usage,
  t,
  locale,
}: {
  usage: CodingAgentTaskUsageSummary;
  t: Translate;
  locale?: string;
}) {
  return (
    <InspectorSection
      title={t("orchestrator.usage.title", { defaultValue: "Tokens & cost" })}
    >
      <div className="mb-2 flex items-center gap-3 text-xs">
        <span className="text-txt">
          <span className="font-semibold tabular-nums">
            {renderTokens(usage, t, locale)}
          </span>{" "}
          <span className="text-muted">
            {t("orchestrator.usage.tokens", { defaultValue: "tokens" })}
          </span>
        </span>
        <span className="text-txt">
          <span className="font-semibold tabular-nums">
            {renderCost(usage, t, locale)}
          </span>
        </span>
      </div>
      {usage.byProvider.length > 1 ? (
        <div className="space-y-1">
          {usage.byProvider.map((entry) => (
            <div
              key={`${entry.provider}-${entry.model ?? "default"}`}
              className="flex items-center gap-2 text-2xs text-muted"
            >
              <span className="min-w-0 flex-1 truncate">
                {entry.provider}
                {entry.model ? ` · ${entry.model}` : ""}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatTokenCount(entry.state, entry.totalTokens, t, locale)}
              </span>
              <span className="shrink-0 tabular-nums">
                {entry.state === "unavailable"
                  ? t("orchestrator.usage.unavailable", { defaultValue: "—" })
                  : formatUsd(entry.costUsd, locale)}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </InspectorSection>
  );
}

const FIELD_CLASS =
  "w-full border-border/35 border-b bg-transparent px-1 py-1.5 text-xs text-txt outline-none transition-colors placeholder:text-muted focus:border-accent/60";

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1 block text-xs font-medium text-muted">
      {children}
    </span>
  );
}

function AddAgentForm({
  busy,
  onClose,
  onSubmit,
  t,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: CodingAgentAddAgentInput) => void;
  t: Translate;
}) {
  const [label, setLabel] = useState("");
  const [framework, setFramework] = useState("");
  const [model, setModel] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [repo, setRepo] = useState("");
  const [task, setTask] = useState("");

  const fieldLabels = {
    label: t("orchestrator.addAgent.label", {
      defaultValue: "Label (optional)",
    }),
    framework: t("orchestrator.addAgent.framework", {
      defaultValue: "Framework",
    }),
    model: t("orchestrator.addAgent.model", { defaultValue: "Model" }),
    workdir: t("orchestrator.addAgent.workdir", {
      defaultValue: "Workdir (optional)",
    }),
    repo: t("orchestrator.addAgent.repo", {
      defaultValue: "Repo URL (optional)",
    }),
    task: t("orchestrator.addAgent.task", {
      defaultValue: "Sub-task for this agent (optional)",
    }),
  };
  const spawnLabel = t("orchestrator.action.spawn", {
    defaultValue: "Spawn agent",
  });
  const cancelLabel = t("orchestrator.action.cancel", {
    defaultValue: "Cancel",
  });
  const spawn = () =>
    onSubmit({
      label: label.trim() || undefined,
      framework: framework.trim() || undefined,
      model: model.trim() || undefined,
      workdir: workdir.trim() || undefined,
      repo: repo.trim() || undefined,
      task: task.trim() || undefined,
    });
  const { ref: labelRef, agentProps: labelAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "add-agent-label",
      role: "text-input",
      label: fieldLabels.label,
      group: "orchestrator-add-agent",
      description: "Optional label for the spawned sub-agent",
      getValue: () => label,
      onFill: (value) => setLabel(value),
    });
  const { ref: frameworkRef, agentProps: frameworkAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "add-agent-framework",
      role: "text-input",
      label: fieldLabels.framework,
      group: "orchestrator-add-agent",
      description: "Coding-agent framework for the sub-agent",
      getValue: () => framework,
      onFill: (value) => setFramework(value),
    });
  const { ref: modelRef, agentProps: modelAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "add-agent-model",
      role: "text-input",
      label: fieldLabels.model,
      group: "orchestrator-add-agent",
      description: "Model for the sub-agent",
      getValue: () => model,
      onFill: (value) => setModel(value),
    });
  const { ref: workdirRef, agentProps: workdirAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "add-agent-workdir",
      role: "text-input",
      label: fieldLabels.workdir,
      group: "orchestrator-add-agent",
      description: "Optional working directory for the sub-agent",
      getValue: () => workdir,
      onFill: (value) => setWorkdir(value),
    });
  const { ref: repoRef, agentProps: repoAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "add-agent-repo",
      role: "text-input",
      label: fieldLabels.repo,
      group: "orchestrator-add-agent",
      description: "Optional repo URL for the sub-agent",
      getValue: () => repo,
      onFill: (value) => setRepo(value),
    });
  const { ref: taskRef, agentProps: taskAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "add-agent-task",
      role: "textarea",
      label: fieldLabels.task,
      group: "orchestrator-add-agent",
      description: "Optional sub-task description for the sub-agent",
      getValue: () => task,
      onFill: (value) => setTask(value),
    });
  const { ref: cancelRef, agentProps: cancelAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "add-agent-cancel",
      role: "button",
      label: cancelLabel,
      group: "orchestrator-add-agent",
      description: "Cancel adding a sub-agent",
    });
  const { ref: spawnRef, agentProps: spawnAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "add-agent-spawn",
      role: "button",
      label: spawnLabel,
      group: "orchestrator-add-agent",
      description: "Spawn a new sub-agent on this task",
      onActivate: () => {
        if (!busy) spawn();
      },
    });

  return (
    <div className="mt-1.5 space-y-1.5">
      <Input
        ref={labelRef}
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        className={FIELD_CLASS}
        placeholder={fieldLabels.label}
        aria-label={fieldLabels.label}
        data-testid="orchestrator-add-agent-label"
        {...labelAgentProps}
      />
      <div className="flex gap-1.5">
        <Input
          ref={frameworkRef}
          value={framework}
          onChange={(event) => setFramework(event.target.value)}
          className={FIELD_CLASS}
          placeholder={fieldLabels.framework}
          aria-label={fieldLabels.framework}
          {...frameworkAgentProps}
        />
        <Input
          ref={modelRef}
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className={FIELD_CLASS}
          placeholder={fieldLabels.model}
          aria-label={fieldLabels.model}
          {...modelAgentProps}
        />
      </div>
      <Input
        ref={workdirRef}
        value={workdir}
        onChange={(event) => setWorkdir(event.target.value)}
        className={FIELD_CLASS}
        placeholder={fieldLabels.workdir}
        aria-label={fieldLabels.workdir}
        {...workdirAgentProps}
      />
      <Input
        ref={repoRef}
        value={repo}
        onChange={(event) => setRepo(event.target.value)}
        className={FIELD_CLASS}
        placeholder={fieldLabels.repo}
        aria-label={fieldLabels.repo}
        {...repoAgentProps}
      />
      <Textarea
        ref={taskRef}
        value={task}
        onChange={(event) => setTask(event.target.value)}
        rows={2}
        className={`${FIELD_CLASS} resize-none`}
        placeholder={fieldLabels.task}
        aria-label={fieldLabels.task}
        {...taskAgentProps}
      />
      <div className="flex justify-end gap-2">
        <Button
          ref={cancelRef}
          variant="secondary"
          size="sm"
          onClick={onClose}
          className="h-6 px-2 text-2xs"
          {...cancelAgentProps}
        >
          {cancelLabel}
        </Button>
        <Button
          ref={spawnRef}
          size="sm"
          disabled={busy}
          onClick={spawn}
          className="h-6 px-2 text-2xs"
          data-testid="orchestrator-add-agent-submit"
          {...spawnAgentProps}
        >
          {spawnLabel}
        </Button>
      </div>
    </div>
  );
}

function ControlButton({
  agentId,
  description,
  icon,
  label,
  onClick,
  disabled,
  tone = "neutral",
  testId,
}: {
  agentId: string;
  description: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  tone?: "neutral" | "danger";
  testId?: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group: "orchestrator-inspector",
    description,
  });
  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex items-center justify-center p-1.5 transition-colors disabled:opacity-50 ${
        tone === "danger"
          ? "text-muted hover:text-danger"
          : "text-muted hover:text-txt"
      }`}
      data-testid={testId}
      {...agentProps}
    >
      {icon}
    </Button>
  );
}

function RecoveryActionButton({
  agentId,
  description,
  icon,
  label,
  onClick,
  disabled,
  testId,
}: {
  agentId: string;
  description: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  testId: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group: "orchestrator-operator-detail",
    description,
  });
  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 items-center gap-1.5 px-1 text-2xs font-semibold text-muted transition-colors hover:text-txt disabled:opacity-50"
      data-testid={testId}
      {...agentProps}
    >
      {icon}
      {label}
    </Button>
  );
}

export function TaskInspector({
  detail,
  className,
  style,
  onClose,
  busy,
  addAgentOpen,
  onPause,
  onResume,
  onArchive,
  onReopen,
  onDelete,
  onFork,
  onRestart,
  onRestartWithEditedPlan,
  onValidate,
  onSetPriority,
  onToggleAddAgent,
  onAddAgent,
  onInspectSession,
  onStopAgent,
  onCopyLink,
  t,
  locale,
}: {
  detail: CodingAgentTaskThreadDetail;
  className?: string;
  style?: CSSProperties;
  onClose?: () => void;
  busy: boolean;
  addAgentOpen: boolean;
  onPause: () => void;
  onResume: () => void;
  onArchive: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onFork: () => void;
  onRestart: () => void;
  onRestartWithEditedPlan: (
    input: CodingAgentRestartWithEditedPlanInput,
  ) => void;
  onValidate: (passed: boolean) => void;
  onSetPriority: (priority: TaskPriority) => void;
  onToggleAddAgent: () => void;
  onAddAgent: (input: CodingAgentAddAgentInput) => void;
  onInspectSession: (sessionId: string) => void;
  onStopAgent: (sessionId: string) => void;
  onCopyLink: () => void;
  t: Translate;
  locale?: string;
}) {
  const plan = normalizePlan(detail.currentPlan);
  const sessions = [...detail.sessions].sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt,
  );
  // The real git change set the latest sub-agent produced, mirrored onto its
  // session record's metadata at task_complete and served by the existing
  // task-detail route. Read-only review surface; absent for in-flight or
  // no-op completions.
  const latestChangeSet = sessions
    .map((session) => readSessionChangeSet(session.metadata))
    .find((value): value is ChangeSetData => value !== undefined);
  const artifacts = [...detail.artifacts].reverse().slice(0, 12);
  const latestPlanRevisionId =
    detail.planRevisions.length > 0
      ? detail.planRevisions[detail.planRevisions.length - 1]?.id
      : undefined;
  const archived = detail.status === "archived";
  const terminal = TERMINAL_TASK_STATUSES.has(detail.status);
  const providerPolicyLine = detail.providerPolicy
    ? [
        detail.providerPolicy.preferredFramework,
        detail.providerPolicy.providerSource,
        detail.providerPolicy.model,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ")
    : "";
  const closeDetailsLabel = t("orchestrator.action.closeDetails", {
    defaultValue: "Close details",
  });
  const setPriorityLabel = t("orchestrator.action.setPriority", {
    defaultValue: "Set priority",
  });
  const { ref: closeRef, agentProps: closeAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "inspector-close",
      role: "button",
      label: closeDetailsLabel,
      group: "orchestrator-inspector",
      description: "Close the task details panel",
    });
  const { ref: priorityRef, agentProps: priorityAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "inspector-priority",
      role: "select",
      label: setPriorityLabel,
      group: "orchestrator-inspector",
      description: "Set the priority of this task",
      options: ["low", "normal", "high", "urgent"],
      getValue: () => detail.priority,
      onFill: (value) => {
        const next = paramPriority(value);
        if (next && next !== detail.priority) onSetPriority(next);
      },
    });

  return (
    <div
      className={`shrink-0 flex-col gap-4 overflow-y-auto bg-bg p-3 ${className ?? "flex w-80"}`}
      style={style}
      data-testid="orchestrator-inspector"
    >
      {onClose ? (
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-muted">
            {t("orchestrator.inspector.title", { defaultValue: "Details" })}
          </h3>
          <Button
            unstyled
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="-mr-1 p-1 text-muted transition-colors hover:text-txt"
            aria-label={closeDetailsLabel}
            data-testid="orchestrator-close-inspector"
            {...closeAgentProps}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {detail.status === "validating" ? (
          <>
            <ControlButton
              agentId="inspector-approve"
              description="Approve the task validation"
              icon={<Check className="h-3 w-3" />}
              label={t("orchestrator.action.approve", {
                defaultValue: "Approve",
              })}
              onClick={() => onValidate(true)}
              disabled={busy}
              testId="orchestrator-approve"
            />
            <ControlButton
              agentId="inspector-reject"
              description="Reject the task validation"
              icon={<X className="h-3 w-3" />}
              label={t("orchestrator.action.reject", {
                defaultValue: "Reject",
              })}
              onClick={() => onValidate(false)}
              disabled={busy}
              tone="danger"
              testId="orchestrator-reject"
            />
          </>
        ) : null}
        {archived ? (
          <ControlButton
            agentId="inspector-reopen"
            description="Reopen this archived task"
            icon={<RotateCcw className="h-3 w-3" />}
            label={t("orchestrator.action.reopen", { defaultValue: "Reopen" })}
            onClick={onReopen}
            disabled={busy}
            testId="orchestrator-reopen"
          />
        ) : terminal ? null : detail.paused ? (
          <ControlButton
            agentId="inspector-resume"
            description="Resume this paused task"
            icon={<Play className="h-3 w-3" />}
            label={t("orchestrator.action.resume", { defaultValue: "Resume" })}
            onClick={onResume}
            disabled={busy}
            testId="orchestrator-inspector-resume"
          />
        ) : (
          <ControlButton
            agentId="inspector-pause"
            description="Pause this task"
            icon={<Pause className="h-3 w-3" />}
            label={t("orchestrator.action.pause", { defaultValue: "Pause" })}
            onClick={onPause}
            disabled={busy}
            testId="orchestrator-inspector-pause"
          />
        )}
        {archived ? null : (
          <ControlButton
            agentId="inspector-archive"
            description="Archive this task"
            icon={<Archive className="h-3 w-3" />}
            label={t("orchestrator.action.archive", {
              defaultValue: "Archive",
            })}
            onClick={onArchive}
            disabled={busy}
            testId="orchestrator-inspector-archive"
          />
        )}
        {terminal ? null : (
          <ControlButton
            agentId="inspector-fork"
            description="Fork this task into a new task"
            icon={<GitFork className="h-3 w-3" />}
            label={t("orchestrator.action.fork", { defaultValue: "Fork" })}
            onClick={onFork}
            disabled={busy}
            testId="orchestrator-fork"
          />
        )}
        {terminal ? null : (
          <ControlButton
            agentId="inspector-restart"
            description="Restart this task with a fresh worker"
            icon={<RotateCcw className="h-3 w-3" />}
            label={t("orchestrator.action.restart", {
              defaultValue: "Restart",
            })}
            onClick={onRestart}
            disabled={busy}
            testId="orchestrator-inspector-restart"
          />
        )}
        {terminal ? null : (
          <ControlButton
            agentId="inspector-add-agent"
            description="Open the add-agent form for this task"
            icon={<UserPlus className="h-3 w-3" />}
            label={t("orchestrator.action.addAgent", {
              defaultValue: "Add agent",
            })}
            onClick={onToggleAddAgent}
            disabled={busy}
            testId="orchestrator-add-agent"
          />
        )}
        <ControlButton
          agentId="inspector-copy-link"
          description="Copy a deep link to this task"
          icon={<Copy className="h-3 w-3" />}
          label={t("orchestrator.action.copyLink", {
            defaultValue: "Copy link",
          })}
          onClick={onCopyLink}
          disabled={busy}
          testId="orchestrator-copy-link"
        />
        {terminal ? null : (
          <Select
            value={detail.priority}
            onValueChange={(value) => {
              const next = paramPriority(value);
              if (next && next !== detail.priority) onSetPriority(next);
            }}
            disabled={busy}
          >
            <SelectTrigger
              ref={priorityRef}
              aria-label={setPriorityLabel}
              className="border-border/35 h-auto w-auto border-b bg-transparent px-1 py-1 text-2xs text-muted transition-colors hover:border-accent/60 hover:text-txt disabled:opacity-50"
              data-testid="orchestrator-priority-select"
              {...priorityAgentProps}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="low">{labelPriority("low", t)}</SelectItem>
              <SelectItem value="normal">
                {labelPriority("normal", t)}
              </SelectItem>
              <SelectItem value="high">{labelPriority("high", t)}</SelectItem>
              <SelectItem value="urgent">
                {labelPriority("urgent", t)}
              </SelectItem>
            </SelectContent>
          </Select>
        )}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <ControlButton
              agentId="inspector-delete"
              description="Delete this task"
              icon={<Trash2 className="h-3 w-3" />}
              label={t("orchestrator.action.delete", {
                defaultValue: "Delete",
              })}
              onClick={() => {}}
              disabled={busy}
              tone="danger"
              testId="orchestrator-delete"
            />
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("orchestrator.confirmDeleteTitle", {
                  defaultValue: "Delete task?",
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t("orchestrator.confirmDelete", {
                  defaultValue:
                    "Delete this task and its transcript? This can't be undone.",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("orchestrator.action.cancel", { defaultValue: "Cancel" })}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={onDelete}
                className="bg-red-600 hover:bg-red-700"
              >
                {t("orchestrator.action.delete", { defaultValue: "Delete" })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {addAgentOpen && !terminal ? (
        <AddAgentForm
          busy={busy}
          onClose={onToggleAddAgent}
          onSubmit={onAddAgent}
          t={t}
        />
      ) : null}

      <InspectorSection
        title={t("orchestrator.goal", { defaultValue: "Goal" })}
      >
        <p className="whitespace-pre-wrap text-xs-tight text-txt">
          {detail.goal || detail.originalRequest}
        </p>
        {detail.parentTaskId ? (
          <p className="mt-1.5 text-2xs text-muted">
            {t("orchestrator.forkedFrom", {
              defaultValue: "Forked from {{id}}",
              id: detail.parentTaskId,
            })}
          </p>
        ) : null}
      </InspectorSection>

      <InspectorSection
        title={t("orchestrator.subAgents", { defaultValue: "Sub-agents" })}
      >
        {sessions.length === 0 ? (
          <p className="text-xs-tight text-muted">
            {t("orchestrator.noSubAgents", {
              defaultValue: "No sub-agents spawned yet.",
            })}
          </p>
        ) : (
          <div className="space-y-1.5">
            {sessions.map((session) => (
              <SubAgentCard
                key={session.id}
                session={session}
                busy={busy}
                onInspect={onInspectSession}
                onStop={onStopAgent}
                t={t}
                locale={locale}
              />
            ))}
          </div>
        )}
      </InspectorSection>

      {latestChangeSet ? (
        <InspectorSection
          title={t("orchestrator.changes", { defaultValue: "Changes" })}
        >
          <DiffReviewPanel changeSet={latestChangeSet} />
        </InspectorSection>
      ) : null}

      {plan ? <PlanSection plan={plan} t={t} /> : null}
      {detail.currentPlan && !terminal ? (
        <EditedPlanRestartSection
          plan={detail.currentPlan}
          latestPlanRevisionId={latestPlanRevisionId}
          busy={busy}
          onSubmit={onRestartWithEditedPlan}
          t={t}
        />
      ) : null}
      {detail.acceptanceCriteria.length > 0 ? (
        <AcceptanceSection criteria={detail.acceptanceCriteria} t={t} />
      ) : null}
      {artifacts.length > 0 ? (
        <ArtifactSection artifacts={artifacts} t={t} />
      ) : null}
      <UsageSection usage={detail.usage} t={t} locale={locale} />

      {providerPolicyLine ? (
        <InspectorSection
          title={t("orchestrator.providerPolicy", {
            defaultValue: "Provider policy",
          })}
        >
          <p className="text-xs-tight text-txt">{providerPolicyLine}</p>
        </InspectorSection>
      ) : null}
    </div>
  );
}

function compactText(value: string, max = 6000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trimEnd()}\n\n… ${(
    value.length - max
  ).toLocaleString()} characters truncated`;
}

function hasRecordEntries(value: Record<string, unknown> | null | undefined) {
  return Boolean(value && Object.keys(value).length > 0);
}

/**
 * Validate a captured change set off a session record's metadata. The orchestrator
 * mirrors its `WorkspaceChangeSet` onto `metadata.lastChangeSet`; guard the shape
 * here so a malformed value never reaches the read-only diff panel.
 */
function readSessionChangeSet(
  metadata: Record<string, unknown>,
): ChangeSetData | undefined {
  const raw = metadata.lastChangeSet;
  if (!raw || typeof raw !== "object") return undefined;
  const candidate = raw as Partial<ChangeSetData>;
  if (!Array.isArray(candidate.changedFiles)) return undefined;
  if (typeof candidate.diff !== "string") return undefined;
  if (typeof candidate.diffStat !== "string") return undefined;
  if (typeof candidate.truncated !== "boolean") return undefined;
  if (typeof candidate.capturedAt !== "number") return undefined;
  return candidate as ChangeSetData;
}

function JsonBlock({
  value,
  emptyLabel,
}: {
  value: unknown;
  emptyLabel: string;
}) {
  const empty =
    value === null ||
    value === undefined ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length === 0);
  if (empty) {
    return <p className="text-xs-tight text-muted">{emptyLabel}</p>;
  }
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre
      className="max-h-72 overflow-auto bg-bg/60 px-2.5 py-1.5 font-mono text-2xs leading-relaxed text-muted"
      data-testid="orchestrator-detail-json"
    >
      {compactText(text)}
    </pre>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === "") return null;
  return (
    <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] gap-2 text-xs-tight">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words text-txt">{value}</span>
    </div>
  );
}

function OperatorTabs({
  active,
  onSelect,
  t,
}: {
  active: OperatorTab;
  onSelect: (tab: OperatorTab) => void;
  t: Translate;
}) {
  const tabs: Array<{ id: OperatorTab; label: string }> = [
    {
      id: "input",
      label: t("orchestrator.detail.tabs.input", { defaultValue: "Input" }),
    },
    {
      id: "output",
      label: t("orchestrator.detail.tabs.output", { defaultValue: "Output" }),
    },
    {
      id: "events",
      label: t("orchestrator.detail.tabs.events", { defaultValue: "Events" }),
    },
    {
      id: "usage",
      label: t("orchestrator.detail.tabs.usage", { defaultValue: "Usage" }),
    },
  ];
  return (
    <div
      className="flex gap-2"
      role="tablist"
      aria-label={t("orchestrator.detail.tabsLabel", {
        defaultValue: "Detail tabs",
      })}
    >
      {tabs.map((tab) => (
        <Button
          unstyled
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onSelect(tab.id)}
          className={`flex-1 px-1 py-1 text-xs font-medium transition-colors ${
            active === tab.id ? "text-accent" : "text-muted hover:text-txt"
          }`}
        >
          {tab.label}
        </Button>
      ))}
    </div>
  );
}

function sessionUsage(
  session: CodingAgentTaskSessionRecord,
): CodingAgentTaskUsageSummary {
  return {
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    reasoningTokens: session.reasoningTokens,
    cacheTokens: session.cacheTokens,
    totalTokens: session.totalTokens,
    costUsd: session.costUsd,
    state: session.usageState,
    byProvider: [
      {
        provider: session.providerSource ?? session.framework,
        model: session.model ?? undefined,
        inputTokens: session.inputTokens,
        outputTokens: session.outputTokens,
        reasoningTokens: session.reasoningTokens,
        cacheTokens: session.cacheTokens,
        totalTokens: session.totalTokens,
        costUsd: session.costUsd,
        state: session.usageState,
      },
    ],
  };
}

function blockEventIds(block: ConversationBlock): string[] {
  if (block.kind === "tool") return block.tool.eventIds;
  if (block.kind === "reasoning") return block.eventIds;
  if (block.kind === "notice") return [block.eventId];
  return [];
}

function blockMessageIds(block: ConversationBlock): string[] {
  if (block.kind === "user" || block.kind === "agent") return block.messageIds;
  return [];
}

function blockSelection(
  block: ConversationBlock,
): Extract<DetailDrawerSelection, { kind: "block" }> {
  return {
    kind: "block",
    blockKey: block.key,
    blockKind: block.kind,
    eventIds: blockEventIds(block),
    messageIds: blockMessageIds(block),
  };
}

function blockMatchesSelection(
  block: ConversationBlock,
  selection: Extract<DetailDrawerSelection, { kind: "block" }>,
): boolean {
  if (block.key === selection.blockKey) return true;
  if (block.kind !== selection.blockKind) return false;
  const eventIds = blockEventIds(block);
  if (
    selection.eventIds.length > 0 &&
    selection.eventIds.some((id) => eventIds.includes(id))
  ) {
    return true;
  }
  const messageIds = blockMessageIds(block);
  return (
    selection.messageIds.length > 0 &&
    selection.messageIds.some((id) => messageIds.includes(id))
  );
}

function blockSelectionKey(selection: DetailDrawerSelection): string {
  if (selection.kind === "session") return `session:${selection.sessionId}`;
  return [
    "block",
    selection.blockKey,
    selection.blockKind,
    selection.eventIds.join(","),
    selection.messageIds.join(","),
  ].join(":");
}

function blockTitle(block: ConversationBlock, t: Translate): string {
  if (block.kind === "tool") return block.tool.title;
  if (block.kind === "agent") return block.senderName;
  if (block.kind === "user")
    return t("orchestrator.detail.userTurn", { defaultValue: "User turn" });
  if (block.kind === "reasoning")
    return t("orchestrator.detail.reasoning", { defaultValue: "Reasoning" });
  return block.eventType.replace(/_/g, " ");
}

function eventError(
  events: CodingAgentTaskEventRecord[],
  t: Translate,
): string | null {
  const error = events.find((event) => event.eventType === "error");
  if (!error) return null;
  const message =
    typeof error.data?.message === "string"
      ? error.data.message
      : typeof error.data?.error === "string"
        ? error.data.error
        : error.summary;
  return (
    message.trim() ||
    t("orchestrator.detail.errorFallback", { defaultValue: "Error" })
  );
}

function blockError(
  block: ConversationBlock | null,
  events: CodingAgentTaskEventRecord[],
  t: Translate,
): string | null {
  const fromEvent = eventError(events, t);
  if (fromEvent) return fromEvent;
  if (!block) return null;
  if (block.kind === "agent" && block.tone === "error") {
    return compactText(block.content, 600);
  }
  if (block.kind === "notice" && block.eventType === "error") {
    return block.text;
  }
  if (block.kind === "tool" && block.tool.status === "failed") {
    if (block.tool.output) return compactText(block.tool.output, 600);
    if (typeof block.tool.exitCode === "number") {
      return t("orchestrator.detail.toolExited", {
        defaultValue: `Tool exited with code ${block.tool.exitCode}.`,
        code: block.tool.exitCode,
      });
    }
    return (
      block.tool.rawStatus ??
      t("orchestrator.detail.toolFailed", { defaultValue: "Tool failed." })
    );
  }
  return null;
}

function sessionError(
  session: CodingAgentTaskSessionRecord,
  t: Translate,
): string | null {
  if (session.status !== "error" && session.status !== "errored") return null;
  return (
    session.completionSummary ??
    session.activeTool ??
    t("orchestrator.detail.sessionFailed", {
      defaultValue: "Session failed.",
    })
  );
}

function ErrorFirstBanner({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <div className="rounded-md bg-red-500/10 px-2.5 py-2 text-xs-tight text-red-500">
      {text}
    </div>
  );
}

function OperatorDrawerShell({
  title,
  subtitle,
  closeLabel,
  className,
  style,
  onClose,
  children,
}: {
  title: string;
  subtitle: string;
  closeLabel: string;
  className?: string;
  style?: CSSProperties;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={`shrink-0 flex-col gap-2.5 overflow-y-auto bg-bg p-3 ${className ?? "flex w-80"}`}
      style={style}
      data-testid="orchestrator-operator-detail"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-xs font-medium text-muted">{title}</h3>
          <p className="mt-0.5 truncate text-xs-tight font-medium text-txt">
            {subtitle}
          </p>
        </div>
        <Button
          unstyled
          type="button"
          onClick={onClose}
          className="-mr-1 p-1 text-muted transition-colors hover:text-txt"
          aria-label={closeLabel}
          data-testid="orchestrator-close-operator-detail"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      {children}
    </div>
  );
}

function EventList({
  events,
  messages,
  locale,
  t,
}: {
  events: CodingAgentTaskEventRecord[];
  messages: CodingAgentTaskMessageRecord[];
  locale?: string;
  t: Translate;
}) {
  if (events.length === 0 && messages.length === 0) {
    return (
      <p className="text-xs-tight text-muted">
        {t("orchestrator.detail.noEvents", {
          defaultValue: "No events captured.",
        })}
      </p>
    );
  }
  const timeline = [
    ...messages.map((message) => ({
      kind: "message" as const,
      id: message.id,
      timestamp: message.timestamp,
      record: message,
    })),
    ...events.map((event) => ({
      kind: "event" as const,
      id: event.id,
      timestamp: event.timestamp,
      record: event,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp);
  return (
    <div className="space-y-1.5">
      {timeline.map((item) => {
        if (item.kind === "message") {
          const message = item.record;
          return (
            <div key={`message-${message.id}`} className="py-1">
              <div className="mb-1 flex items-center gap-2 text-2xs text-muted">
                <span className="font-semibold text-txt">
                  {message.senderKind}
                </span>
                <span>{message.direction}</span>
                <span className="ml-auto tabular-nums">
                  {formatClockTime(message.timestamp, locale)}
                </span>
              </div>
              <JsonBlock
                value={message}
                emptyLabel={t("orchestrator.detail.noMessagePayload", {
                  defaultValue: "No message payload.",
                })}
              />
            </div>
          );
        }
        const event = item.record;
        return (
          <div key={`event-${event.id}`} className="py-1">
            <div className="mb-1 flex items-center gap-2 text-2xs text-muted">
              <span className="font-semibold text-txt">
                {event.eventType.replace(/_/g, " ")}
              </span>
              <span className="ml-auto tabular-nums">
                {formatClockTime(event.timestamp, locale)}
              </span>
            </div>
            {event.summary ? (
              <p className="mb-1 text-xs-tight text-txt">{event.summary}</p>
            ) : null}
            <JsonBlock
              value={event.data}
              emptyLabel={t("orchestrator.detail.noEventData", {
                defaultValue: "No event data.",
              })}
            />
          </div>
        );
      })}
    </div>
  );
}

function OperatorDetailDrawer({
  selection,
  block,
  session,
  events,
  messages,
  taskUsage,
  busy,
  className,
  style,
  onClose,
  onRetry,
  onRerun,
  t,
  locale,
}: {
  selection: DetailDrawerSelection;
  block: ConversationBlock | null;
  session: CodingAgentTaskSessionRecord | null;
  events: CodingAgentTaskEventRecord[];
  messages: CodingAgentTaskMessageRecord[];
  taskUsage: CodingAgentTaskUsageSummary;
  busy: boolean;
  className?: string;
  style?: CSSProperties;
  onClose: () => void;
  onRetry: (input: CodingAgentRetryTurnInput) => void;
  onRerun: (input: CodingAgentRerunFromEventInput) => void;
  t: Translate;
  locale?: string;
}) {
  const [tab, setTab] = useState<OperatorTab>("input");
  const closeDetailsLabel = t("orchestrator.detail.close", {
    defaultValue: "Close details",
  });
  const label = (key: string, defaultValue: string) =>
    t(`orchestrator.detail.${key}`, { defaultValue });

  if (selection.kind === "session" && !session) {
    return (
      <OperatorDrawerShell
        title={t("orchestrator.detail.session", { defaultValue: "Session" })}
        subtitle={t("orchestrator.detail.noLongerAvailable", {
          defaultValue: "No longer available",
        })}
        closeLabel={closeDetailsLabel}
        className={className}
        style={style}
        onClose={onClose}
      >
        <p className="text-xs-tight text-muted">
          {t("orchestrator.detail.sessionDataChanged", {
            defaultValue: "Session data changed.",
          })}
        </p>
      </OperatorDrawerShell>
    );
  }
  if (selection.kind === "block" && !block) {
    return (
      <OperatorDrawerShell
        title={t("orchestrator.detail.event", { defaultValue: "Event" })}
        subtitle={t("orchestrator.detail.noLongerAvailable", {
          defaultValue: "No longer available",
        })}
        closeLabel={closeDetailsLabel}
        className={className}
        style={style}
        onClose={onClose}
      >
        <p className="text-xs-tight text-muted">
          {t("orchestrator.detail.timelineDataChanged", {
            defaultValue: "Timeline data changed.",
          })}
        </p>
      </OperatorDrawerShell>
    );
  }

  const isSession = selection.kind === "session";
  const title = isSession
    ? t("orchestrator.detail.sessionDetail", { defaultValue: "Session detail" })
    : t("orchestrator.detail.timelineDetail", {
        defaultValue: "Timeline detail",
      });
  const subtitle = isSession
    ? (session?.label ??
      t("orchestrator.detail.session", { defaultValue: "Session" }))
    : block
      ? blockTitle(block, t)
      : t("orchestrator.detail.event", { defaultValue: "Event" });
  const activeUsage = session ? sessionUsage(session) : taskUsage;
  const toolUsageFallbackLabel = session
    ? label(
        "perToolUsageUnavailable",
        "Per-tool usage is not emitted yet; showing the owning session total.",
      )
    : label(
        "perToolUsageTaskFallback",
        "Per-tool usage is not emitted yet; showing the task total.",
      );
  const errorText =
    isSession && session
      ? sessionError(session, t)
      : block
        ? blockError(block, events, t)
        : null;
  const retryMessage = !isSession ? messages[0] : null;
  const rerunEvent = !isSession ? events[0] : null;
  const retryLabel = label("retry", "Retry");
  const rerunLabel = label("rerun", "Rerun");
  const recoveryActions: ReactNode[] = [];
  if (isSession && session) {
    recoveryActions.push(
      <RecoveryActionButton
        key="retry-session"
        agentId="operator-retry-session"
        description="Retry this session's work in a new worker"
        icon={<RotateCcw className="h-3 w-3" />}
        label={retryLabel}
        onClick={() =>
          onRetry({
            sessionId: session.sessionId,
            mode: "new-session",
            instruction: `Retry work from session ${session.label ?? session.sessionId}.`,
          })
        }
        disabled={busy}
        testId="orchestrator-detail-retry"
      />,
    );
  } else if (retryMessage) {
    recoveryActions.push(
      <RecoveryActionButton
        key="retry-message"
        agentId="operator-retry-message"
        description="Retry this selected turn in a new worker"
        icon={<RotateCcw className="h-3 w-3" />}
        label={retryLabel}
        onClick={() =>
          onRetry({
            messageId: retryMessage.id,
            sessionId: retryMessage.sessionId ?? undefined,
            mode: "new-session",
            instruction: "Retry this selected turn.",
          })
        }
        disabled={busy}
        testId="orchestrator-detail-retry"
      />,
    );
  }
  if (rerunEvent) {
    recoveryActions.push(
      <RecoveryActionButton
        key="rerun-event"
        agentId="operator-rerun-event"
        description="Rerun from this selected event without rewriting history"
        icon={<ChevronsUp className="h-3 w-3" />}
        label={rerunLabel}
        onClick={() =>
          onRerun({
            eventId: rerunEvent.id,
            instruction: `Rerun from ${rerunEvent.eventType.replace(/_/g, " ")}.`,
            stopActive: false,
            preserveHistory: true,
          })
        }
        disabled={busy}
        testId="orchestrator-detail-rerun"
      />,
    );
  }

  let body: ReactNode;
  if (tab === "input") {
    if (isSession && session) {
      body = (
        <div className="space-y-2">
          <DetailRow
            label={label("status", "Status")}
            value={session.status.replace(/_/g, " ")}
          />
          <DetailRow
            label={label("framework", "Framework")}
            value={session.framework}
          />
          <DetailRow
            label={label("provider", "Provider")}
            value={session.providerSource}
          />
          <DetailRow label={label("model", "Model")} value={session.model} />
          <DetailRow
            label={label("workdir", "Workdir")}
            value={session.workdir}
          />
          <DetailRow label={label("repo", "Repo")} value={session.repo} />
          <InspectorSection title={label("originalTask", "Original task")}>
            <p className="whitespace-pre-wrap text-xs-tight text-txt">
              {session.originalTask}
            </p>
          </InspectorSection>
          {hasRecordEntries(session.metadata) ? (
            <InspectorSection title={label("metadata", "Metadata")}>
              <JsonBlock
                value={session.metadata}
                emptyLabel={label("noMetadata", "No metadata.")}
              />
            </InspectorSection>
          ) : null}
        </div>
      );
    } else if (block?.kind === "tool") {
      const input = block.tool.rawInput ?? {};
      body = (
        <div className="space-y-2">
          <DetailRow label={label("toolId", "Tool id")} value={block.tool.id} />
          <DetailRow
            label={label("kind", "Kind")}
            value={block.tool.kind || "tool"}
          />
          <DetailRow
            label={label("status", "Status")}
            value={block.tool.rawStatus ?? block.tool.status}
          />
          <DetailRow
            label={label("file", "File")}
            value={block.tool.filePath}
          />
          <DetailRow
            label={label("command", "Command")}
            value={block.tool.command}
          />
          <DetailRow label={label("query", "Query")} value={block.tool.query} />
          <JsonBlock
            value={input}
            emptyLabel={label("noToolInput", "No tool input captured.")}
          />
        </div>
      );
    } else if (block?.kind === "user") {
      body = (
        <pre className="whitespace-pre-wrap bg-bg/60 px-2.5 py-1.5 text-xs-tight text-txt">
          {block.content}
        </pre>
      );
    } else if (block?.kind === "agent") {
      body = (
        <JsonBlock
          value={messages.map((message) => message.metadata)}
          emptyLabel={label("noInputMetadata", "No input metadata captured.")}
        />
      );
    } else {
      body = (
        <JsonBlock
          value={events.map((event) => event.data)}
          emptyLabel={label("noInput", "No input captured.")}
        />
      );
    }
  } else if (tab === "output") {
    if (isSession && session) {
      body = (
        <div className="space-y-2">
          <DetailRow
            label={label("activeTool", "Active tool")}
            value={session.activeTool}
          />
          <DetailRow
            label={label("decisions", "Decisions")}
            value={t("orchestrator.detail.decisionCounts", {
              defaultValue: `${session.decisionCount} total · ${session.autoResolvedCount} auto`,
              count: session.decisionCount,
              auto: session.autoResolvedCount,
            })}
          />
          <DetailRow
            label={label("lastInput", "Last input")}
            value={
              session.lastInputSentAt
                ? formatClockTime(session.lastInputSentAt, locale)
                : null
            }
          />
          <InspectorSection title={label("completion", "Completion")}>
            {session.completionSummary ? (
              <p className="whitespace-pre-wrap text-xs-tight text-txt">
                {session.completionSummary}
              </p>
            ) : (
              <p className="text-xs-tight text-muted">
                {label("noCompletion", "No completion yet.")}
              </p>
            )}
          </InspectorSection>
        </div>
      );
    } else if (block?.kind === "tool") {
      body = (
        <div className="space-y-2">
          <DetailRow
            label={label("exit", "Exit")}
            value={block.tool.exitCode}
          />
          <DetailRow
            label={label("duration", "Duration")}
            value={
              block.tool.durationMs
                ? formatDuration(block.tool.durationMs)
                : null
            }
          />
          <ToolBody tool={block.tool} />
          <JsonBlock
            value={block.tool.rawOutput}
            emptyLabel={label("noRawOutput", "No raw output payload captured.")}
          />
        </div>
      );
    } else if (block?.kind === "agent" || block?.kind === "user") {
      body = (
        <pre className="whitespace-pre-wrap bg-bg/60 px-2.5 py-1.5 text-xs-tight text-txt">
          {compactText(block.content)}
        </pre>
      );
    } else if (block?.kind === "reasoning") {
      body = (
        <pre className="whitespace-pre-wrap bg-bg/60 px-2.5 py-1.5 text-xs-tight text-txt">
          {compactText(block.text)}
        </pre>
      );
    } else if (block) {
      body = <p className="text-xs-tight text-txt">{block.text}</p>;
    } else {
      body = null;
    }
  } else if (tab === "events") {
    body = (
      <EventList events={events} messages={messages} locale={locale} t={t} />
    );
  } else {
    body = (
      <div className="space-y-2">
        {block?.kind === "tool" ? (
          <p className="text-xs-tight text-muted">{toolUsageFallbackLabel}</p>
        ) : null}
        <UsageSection usage={activeUsage} t={t} locale={locale} />
      </div>
    );
  }

  return (
    <OperatorDrawerShell
      title={title}
      subtitle={subtitle}
      closeLabel={closeDetailsLabel}
      className={className}
      style={style}
      onClose={onClose}
    >
      <ErrorFirstBanner text={errorText} />
      <div className="space-y-1.5">
        {session ? (
          <>
            <DetailRow
              label={label("session", "Session")}
              value={session.sessionId}
            />
            <DetailRow
              label={label("activity", "Activity")}
              value={formatClockTime(session.lastActivityAt, locale)}
            />
          </>
        ) : null}
        {block ? (
          <>
            <DetailRow label={label("kind", "Kind")} value={block.kind} />
            <DetailRow
              label={label("time", "Time")}
              value={formatClockTime(block.at, locale)}
            />
          </>
        ) : null}
      </div>
      {recoveryActions.length > 0 ? (
        <div className="space-y-1.5" data-testid="orchestrator-detail-recovery">
          <div className="text-xs font-medium text-muted">
            {label("recovery", "Recovery")}
          </div>
          <div className="flex flex-wrap gap-1.5">{recoveryActions}</div>
        </div>
      ) : null}
      <OperatorTabs active={tab} onSelect={setTab} t={t} />
      <div className="min-h-0">{body}</div>
    </OperatorDrawerShell>
  );
}

function readInitialTaskId(): string | null {
  if (typeof window === "undefined") return null;
  // Accept both producers: `?task=` (copy-link) and `?taskId=` (the in-chat
  // task widget). Either opens the workbench straight onto that task.
  const params = new URLSearchParams(window.location.search);
  return params.get("task") ?? params.get("taskId");
}

const MOBILE_QUERY = "(max-width: 767px)";

// The view bundle ships no CSS — it borrows the host stylesheet, which never
// generates the plugin's responsive (`md:`) variants. So responsiveness is
// driven in JS via matchMedia and applied with always-present classes + inline
// styles instead of breakpoint utilities.
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(MOBILE_QUERY).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(MOBILE_QUERY);
    const onChange = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);
  return isMobile;
}

// Mobile inspector slide-over geometry. Inline styles (not `md:` utilities)
// because the bundle has no CSS of its own — see useIsMobile.
export const INSPECTOR_DRAWER_STYLE: CSSProperties = {
  position: "absolute",
  insetBlock: 0,
  right: 0,
  zIndex: 30,
  width: "86%",
  maxWidth: "22rem",
  boxShadow: "0 10px 30px rgba(0, 0, 0, 0.45)",
};

export const HIDDEN_STYLE: CSSProperties = { display: "none" };

// Timeline header above the message stream. Desktop packs it into one row;
// mobile splits into a title row (back · status · title · details) and a
// secondary controls row (status badge · system-events toggle) so the task
// title is never crushed by the trailing controls.
function TimelineHeader({
  detail,
  isMobile,
  onBack,
  onOpenInspector,
  t,
}: {
  detail: CodingAgentTaskThreadDetail;
  isMobile: boolean;
  onBack: () => void;
  onOpenInspector: () => void;
  t: Translate;
}) {
  const statusDot = (
    <StatusGlyph
      status={detail.status}
      paused={detail.paused}
      t={t}
      size="h-4 w-4"
    />
  );
  const title = (
    <span className="min-w-0 flex-1 truncate text-sm font-semibold text-txt">
      {detail.title}
    </span>
  );
  const pausedLabel = t("orchestrator.status.paused", {
    defaultValue: "Paused",
  });
  const pausedBadge = detail.paused ? (
    <span
      className="inline-flex shrink-0 text-warn"
      title={pausedLabel}
      aria-label={pausedLabel}
      role="img"
    >
      <Pause className="h-3.5 w-3.5" aria-hidden />
    </span>
  ) : null;
  const detailsLabel = t("orchestrator.action.details", {
    defaultValue: "Details",
  });
  const backLabel = t("orchestrator.action.backToList", {
    defaultValue: "Back to tasks",
  });
  const { ref: backRef, agentProps: backAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "timeline-back",
      role: "button",
      label: backLabel,
      group: "orchestrator-timeline",
      description: "Go back to the task list",
    });
  const { ref: detailsRef, agentProps: detailsAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "timeline-open-inspector",
      role: "button",
      label: detailsLabel,
      group: "orchestrator-timeline",
      description: "Open the task details panel",
    });

  if (isMobile) {
    return (
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <Button
            unstyled
            ref={backRef}
            type="button"
            onClick={onBack}
            className="-ml-1 shrink-0 p-1 text-muted transition-colors hover:text-txt"
            aria-label={backLabel}
            data-testid="orchestrator-back"
            {...backAgentProps}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          {statusDot}
          {title}
          <Button
            unstyled
            ref={detailsRef}
            type="button"
            onClick={onOpenInspector}
            className="shrink-0 p-1 text-muted transition-colors hover:text-txt"
            aria-label={detailsLabel}
            title={detailsLabel}
            data-testid="orchestrator-open-inspector"
            {...detailsAgentProps}
          >
            <PanelRightOpen className="h-4 w-4" aria-hidden />
          </Button>
        </div>
        {pausedBadge ? (
          <div className="mt-1.5 flex items-center gap-1.5">{pausedBadge}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5">
      <BackChip label={backLabel} onClick={onBack} testId="orchestrator-back" />
      {statusDot}
      {title}
      {pausedBadge}
      <Button
        unstyled
        ref={detailsRef}
        type="button"
        onClick={onOpenInspector}
        className="shrink-0 p-1 text-muted transition-colors hover:text-txt"
        aria-label={detailsLabel}
        title={detailsLabel}
        data-testid="orchestrator-open-inspector"
        {...detailsAgentProps}
      >
        <PanelRightOpen className="h-4 w-4" aria-hidden />
      </Button>
    </div>
  );
}

export function OrchestratorWorkbench() {
  const {
    t: appT,
    uiLanguage,
    copyToClipboard,
    agentStatus,
    setTab,
  } = useAppSelectorShallow((s) => ({
    t: s.t,
    uiLanguage: s.uiLanguage,
    copyToClipboard: s.copyToClipboard,
    agentStatus: s.agentStatus,
    setTab: s.setTab,
  }));
  const t = appT ?? fallbackTranslate;
  const locale = typeof uiLanguage === "string" ? uiLanguage : undefined;
  const mainAgentName =
    typeof agentStatus?.agentName === "string"
      ? agentStatus.agentName
      : undefined;

  const [selectedId, setSelectedId] = useState<string | null>(
    readInitialTaskId,
  );
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [detailDrawer, setDetailDrawer] =
    useState<DetailDrawerSelection | null>(null);

  const isMobile = useIsMobile();
  const deferredSearch = useDeferredValue(search.trim());
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;

  // The live-data layer (status/tasks/detail/timeline + fetch / poll / SSE /
  // mutation) lives in useOrchestratorData; this component owns the UI state
  // (selection, filters, drawers) and feeds it in.
  const {
    status,
    tasks,
    detail,
    messages,
    events,
    timelineCursor,
    loading,
    mutating,
    loadError,
    backendAbsent,
    actionError,
    runMutation,
    loadOlderTimeline,
  } = useOrchestratorData({
    selectedId,
    showArchived,
    statusFilter,
    deferredSearch,
    t,
  });

  // The conversation sticks to the newest entry, but only while the reader is
  // already near the bottom — scrolling up to read history is never yanked by
  // a streaming update.
  const listRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const handleListScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    stickToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // Reset transient per-task UI (mobile inspector drawer, add-agent form, the
  // detail drawer) and re-pin to bottom whenever the selection changes, so a
  // freshly opened task starts clean. The room itself is loaded by the data
  // layer (useOrchestratorData) reacting to the same selectedId.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on selection change
  useEffect(() => {
    setInspectorOpen(false);
    setAddAgentOpen(false);
    setDetailDrawer(null);
    stickToBottomRef.current = true;
  }, [selectedId]);

  // Stop every still-running coding agent on the open task — the prominent
  // in-conversation interrupt (parity with Claude Code / Codex / opencode),
  // also bound to Esc below.
  const handleStopActive = useCallback(() => {
    const current = detail;
    if (!current) return;
    const targets = current.sessions.filter(
      (session) =>
        session.sessionId &&
        session.stoppedAt == null &&
        session.status !== "completed",
    );
    if (targets.length === 0) return;
    void runMutation(async () => {
      for (const session of targets) {
        await client.stopOrchestratorAgent(current.id, session.sessionId);
      }
    });
  }, [detail, runMutation]);

  // Esc closes an open modal/drawer first; only when nothing is open does it
  // interrupt the running turn. A ref keeps the document listener stable while
  // always seeing the latest state (otherwise Esc-to-stop would trap an open
  // dialog, blocking the whole UI).
  const escStateRef = useRef({
    addAgentOpen,
    inspectorOpen,
    detailDrawer,
    stop: handleStopActive,
  });
  escStateRef.current = {
    addAgentOpen,
    inspectorOpen,
    detailDrawer,
    stop: handleStopActive,
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const s = escStateRef.current;
      if (s.addAgentOpen) {
        setAddAgentOpen(false);
        return;
      }
      if (s.inspectorOpen) {
        setInspectorOpen(false);
        return;
      }
      if (s.detailDrawer) {
        setDetailDrawer(null);
        return;
      }
      s.stop();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const handleCopyLink = useCallback(() => {
    const current = selectedIdRef.current;
    if (!current || !copyToClipboard || typeof window === "undefined") return;
    const url = `${window.location.origin}/orchestrator?task=${encodeURIComponent(current)}`;
    void copyToClipboard(url);
  }, [copyToClipboard]);

  const sessionLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of detail?.sessions ?? []) {
      const label = session.label?.trim();
      if (session.sessionId && label) map.set(session.sessionId, label);
    }
    return map;
  }, [detail?.sessions]);

  const finishedSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of detail?.sessions ?? []) {
      if (
        session.sessionId &&
        (session.stoppedAt != null || session.status === "completed")
      ) {
        ids.add(session.sessionId);
      }
    }
    return ids;
  }, [detail?.sessions]);

  const conversation = useMemo(
    () =>
      buildConversation(
        messages,
        events,
        (message) =>
          resolveSenderName(message, sessionLabelById, mainAgentName, t),
        finishedSessionIds,
      ),
    [messages, events, sessionLabelById, mainAgentName, finishedSessionIds, t],
  );
  const selectedBlock = useMemo(() => {
    if (detailDrawer?.kind !== "block") return null;
    return (
      conversation.find((block) =>
        blockMatchesSelection(block, detailDrawer),
      ) ?? null
    );
  }, [conversation, detailDrawer]);
  const selectedSession = useMemo(() => {
    if (detailDrawer?.kind !== "session" || !detail) return null;
    return (
      detail.sessions.find(
        (session) => session.sessionId === detailDrawer.sessionId,
      ) ?? null
    );
  }, [detail, detailDrawer]);
  const selectedBlockEvents = useMemo(() => {
    if (!detailDrawer) return [];
    if (detailDrawer.kind === "session") {
      return events.filter(
        (event) => event.sessionId === detailDrawer.sessionId,
      );
    }
    const ids = new Set(detailDrawer.eventIds);
    return events.filter((event) => ids.has(event.id));
  }, [detailDrawer, events]);
  const selectedBlockMessages = useMemo(() => {
    if (!detailDrawer) return [];
    if (detailDrawer.kind === "session") {
      return messages.filter(
        (message) => message.sessionId === detailDrawer.sessionId,
      );
    }
    const ids = new Set(detailDrawer.messageIds);
    return messages.filter((message) => ids.has(message.id));
  }, [detailDrawer, messages]);
  const handleSelectBlock = useCallback(
    (block: ConversationBlock) => {
      setDetailDrawer(blockSelection(block));
      if (isMobile) setInspectorOpen(true);
    },
    [isMobile],
  );
  const handleInspectSession = useCallback(
    (sessionId: string) => {
      setDetailDrawer({ kind: "session", sessionId });
      if (isMobile) setInspectorOpen(true);
    },
    [isMobile],
  );

  // Re-pin to the newest entry whenever the conversation grows (subject to the
  // near-bottom guard); `conversation` is the change trigger, not read here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [conversation]);

  const viewState = JSON.stringify({
    selectedId,
    taskCount: status?.taskCount ?? tasks.length,
    activeTaskCount: status?.activeTaskCount ?? 0,
    statusFilter,
    showArchived,
  });

  const searchLabel = t("orchestrator.searchPlaceholder", {
    defaultValue: "Search tasks",
  });
  const showArchivedLabel = t("orchestrator.showArchived", {
    defaultValue: "Show archived",
  });
  const loadOlderLabel = t("orchestrator.loadOlder", {
    defaultValue: "Load older",
  });
  const stopLabel = t("orchestrator.action.stop", { defaultValue: "Stop" });
  const { ref: searchRef, agentProps: searchAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "rail-search",
      role: "text-input",
      label: searchLabel,
      group: "orchestrator-rail",
      description: "Filter the task list by title or request text",
      getValue: () => search,
      onFill: (value) => setSearch(value),
    });
  const { ref: showArchivedRef, agentProps: showArchivedAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "rail-show-archived",
      role: "toggle",
      label: showArchivedLabel,
      group: "orchestrator-rail",
      status: showArchived ? "active" : "inactive",
      description: "Toggle showing archived tasks in the list",
      onActivate: () => setShowArchived((value) => !value),
    });
  const { ref: loadOlderRef, agentProps: loadOlderAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "timeline-load-older",
      role: "button",
      label: loadOlderLabel,
      group: "orchestrator-timeline",
      description: "Load older entries in the task timeline",
    });
  const { ref: stopActiveRef, agentProps: stopActiveAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "timeline-stop-active",
      role: "button",
      label: stopLabel,
      group: "orchestrator-timeline",
      description: "Stop the running sub-agents on this task",
    });
  return (
    <div
      className="relative flex h-full min-h-0 w-full flex-col bg-bg text-txt"
      data-testid="orchestrator-workbench"
    >
      <span data-view-state={viewState} hidden />
      <WorkbenchHeader
        status={status}
        busy={mutating}
        isMobile={isMobile}
        onPauseAll={() => runMutation(() => client.pauseAllOrchestratorTasks())}
        onResumeAll={() =>
          runMutation(() => client.resumeAllOrchestratorTasks())
        }
        accountsOpen={accountsOpen}
        onToggleAccounts={() => setAccountsOpen((prev) => !prev)}
        t={t}
        locale={locale}
      />

      {accountsOpen ? (
        <div className="border-b border-border/40 px-4 py-2">
          <OrchestratorAccountHealthPanel
            t={t}
            onConnect={() => setTab?.("settings")}
          />
        </div>
      ) : null}

      {backendAbsent ? (
        <div className="px-4 py-1.5 text-2xs text-muted">
          {t("orchestrator.backendAbsent", {
            defaultValue: "Connect a cloud or desktop agent to run tasks.",
          })}
        </div>
      ) : null}
      {loadError ? (
        <div className="bg-danger/10 px-3 py-1.5 text-xs text-danger">
          {loadError}
        </div>
      ) : null}
      {actionError ? (
        <div className="bg-danger/10 px-3 py-1.5 text-xs text-danger">
          {actionError}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-y-auto">
        {/* Single-pane landing: visual task card list. Hidden once a task room
            is open so the workbench is never a side-by-side list+detail. */}
        {!selectedId ? (
          <div
            className="relative flex flex-1 flex-col gap-3 px-4 pb-28 pt-4"
            data-testid="orchestrator-rail"
          >
            {tasks.length > 0 || loading ? (
              <div className="flex flex-wrap items-center gap-2">
                <TaskSearchInput
                  value={search}
                  onChange={setSearch}
                  placeholder={searchLabel}
                  inputRef={searchRef}
                  testId="orchestrator-search"
                  className="min-w-[12rem] flex-1"
                  agentProps={searchAgentProps}
                />
                <div className="flex items-center gap-2">
                  <div className="w-40">
                    <FilterSelect
                      status={status}
                      active={statusFilter}
                      onSelect={setStatusFilter}
                      t={t}
                    />
                  </div>
                  <Button
                    unstyled
                    ref={showArchivedRef}
                    type="button"
                    onClick={() => setShowArchived((value) => !value)}
                    aria-pressed={showArchived}
                    className={`inline-flex h-9 items-center gap-2 px-2 text-xs font-medium transition-colors ${
                      showArchived ? "text-accent" : "text-muted hover:text-txt"
                    }`}
                    data-testid="orchestrator-show-archived"
                    {...showArchivedAgentProps}
                  >
                    <Archive className="h-3.5 w-3.5" />
                    {showArchivedLabel}
                  </Button>
                </div>
              </div>
            ) : null}

            {tasks.length === 0 ? (
              loading ? (
                <p className="p-2 text-sm text-muted">
                  {t("orchestrator.loadingTasks", {
                    defaultValue: "Loading",
                  })}
                </p>
              ) : (
                <TaskEmptyState
                  title={
                    backendAbsent
                      ? t("orchestrator.empty.setupTitle", {
                          defaultValue:
                            "Connect a cloud or desktop agent to run tasks here.",
                        })
                      : t("orchestrator.empty.title", {
                          defaultValue: "No tasks yet.",
                        })
                  }
                  hint={t("orchestrator.empty.hint", {
                    defaultValue: "Tasks you start appear here.",
                  })}
                />
              )
            ) : (
              <>
                <div className="flex flex-col gap-2.5">
                  {tasks.map((thread) => (
                    <TaskCard
                      key={thread.id}
                      id={thread.id}
                      title={thread.title}
                      subtitle={thread.summary || thread.originalRequest}
                      status={thread.status}
                      chips={orchestratorTaskChips(thread, t, locale)}
                      onOpen={(id) => setSelectedId(id)}
                      t={t}
                    />
                  ))}
                </div>
                {tasks.length < 4 ? <SparseWatermark icon={Layers} /> : null}
              </>
            )}
          </div>
        ) : null}

        {/* Task room — full-pane detail, entered by clicking a card. */}
        <main
          className="flex min-h-0 min-w-0 flex-1 flex-col bg-bg"
          data-testid="orchestrator-timeline"
          // Keep a real minimum height in the one-column desktop layout: stacked
          // below the (often tall) inspector, a basis-0 flex-1 timeline would
          // otherwise collapse toward zero and bleed its header over the
          // inspector's controls. A definite floor makes the outer container
          // scroll through both panels instead. Inline (the view bundle ships no
          // CSS of its own). Hidden entirely until a task room is open.
          style={selectedId ? { minHeight: "20rem" } : HIDDEN_STYLE}
        >
          {detail ? (
            <>
              <TimelineHeader
                detail={detail}
                isMobile={isMobile}
                onBack={() => setSelectedId(null)}
                onOpenInspector={() => {
                  setDetailDrawer(null);
                  setInspectorOpen(true);
                }}
                t={t}
              />
              <div
                ref={listRef}
                onScroll={handleListScroll}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
                data-testid="orchestrator-message-list"
              >
                {timelineCursor ? (
                  <div className="flex justify-center">
                    <Button
                      unstyled
                      ref={loadOlderRef}
                      type="button"
                      onClick={() => void loadOlderTimeline()}
                      className="flex items-center gap-1 px-1 py-0.5 text-2xs text-muted transition-colors hover:text-txt"
                      data-testid="orchestrator-load-older"
                      aria-label={loadOlderLabel}
                      {...loadOlderAgentProps}
                    >
                      <ArrowDownToLine className="h-3 w-3" />
                      {loadOlderLabel}
                    </Button>
                  </div>
                ) : null}
                {conversation.length === 0 ? (
                  <p className="p-4 text-center text-xs text-muted">
                    {t("orchestrator.noMessages", {
                      defaultValue: "No messages yet.",
                    })}
                  </p>
                ) : (
                  conversation.map((block) => {
                    const selected =
                      detailDrawer?.kind === "block" &&
                      blockMatchesSelection(block, detailDrawer);
                    return (
                      <div
                        key={block.key}
                        className={`group flex gap-1.5 transition-colors ${
                          selected ? "text-accent" : "hover:bg-bg-hover/30"
                        }`}
                        data-testid="orchestrator-conversation-block"
                      >
                        <Button
                          unstyled
                          type="button"
                          onClick={() => handleSelectBlock(block)}
                          className="mt-1.5 flex h-6 w-6 shrink-0 items-center justify-center text-muted opacity-0 transition-colors hover:text-txt focus:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100"
                          aria-label={t("orchestrator.action.inspectBlock", {
                            defaultValue: `Inspect ${blockTitle(block, t)}`,
                          })}
                          title={t("orchestrator.action.inspectBlock", {
                            defaultValue: `Inspect ${blockTitle(block, t)}`,
                          })}
                          data-testid="orchestrator-inspect-block"
                        >
                          <PanelRightOpen className="h-3.5 w-3.5" />
                        </Button>
                        <div className="min-w-0 flex-1">
                          <ConversationBlockView
                            block={block}
                            locale={locale}
                            onInspect={() => handleSelectBlock(block)}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
              {detail.activeSessionCount > 0 ? (
                <div
                  className="flex items-center justify-between gap-2 bg-warn/5 px-3 py-1.5"
                  data-testid="orchestrator-running-bar"
                >
                  <span className="flex items-center gap-1.5 text-2xs font-medium text-warn">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
                    {t("orchestrator.agentsWorking", {
                      defaultValue: "Agent working…",
                    })}
                  </span>
                  <Button
                    unstyled
                    ref={stopActiveRef}
                    type="button"
                    onClick={handleStopActive}
                    disabled={mutating}
                    className="flex items-center gap-1 px-1 py-0.5 text-2xs text-txt transition-colors hover:text-danger disabled:opacity-50"
                    data-testid="orchestrator-stop-active"
                    aria-label={stopLabel}
                    {...stopActiveAgentProps}
                  >
                    <CircleStop className="h-3 w-3" />
                    {stopLabel}
                    <kbd className="ml-0.5 px-1 text-[0.9em] text-muted">
                      Esc
                    </kbd>
                  </Button>
                </div>
              ) : null}
              <div className="pb-24" />
            </>
          ) : (
            <>
              <div className="flex items-center gap-2.5 px-4 py-2.5">
                <BackChip
                  label={t("orchestrator.action.backToList", {
                    defaultValue: "Tasks",
                  })}
                  onClick={() => setSelectedId(null)}
                  testId="orchestrator-back-loading"
                />
                <span className="text-sm font-medium text-muted">
                  {t("orchestrator.loadingTask", {
                    defaultValue: "Loading task…",
                  })}
                </span>
              </div>
              <div className="flex flex-1 items-center justify-center p-6">
                <p className="text-xs text-muted">
                  {t("orchestrator.loadingTask", {
                    defaultValue: "Loading task…",
                  })}
                </p>
              </div>
            </>
          )}
        </main>

        {/* Inspector — stacked below activity so the registered view stays one-column. */}
        {detail && isMobile && inspectorOpen ? (
          <Button
            unstyled
            type="button"
            aria-label={t("orchestrator.action.closeDetails", {
              defaultValue: "Close details",
            })}
            onClick={() => {
              setInspectorOpen(false);
              setDetailDrawer(null);
            }}
            className="absolute inset-0 z-20 bg-black/40"
            data-testid="orchestrator-inspector-backdrop"
          />
        ) : null}
        {detail && detailDrawer ? (
          <OperatorDetailDrawer
            key={blockSelectionKey(detailDrawer)}
            selection={detailDrawer}
            block={selectedBlock}
            session={selectedSession}
            events={selectedBlockEvents}
            messages={selectedBlockMessages}
            taskUsage={detail.usage}
            busy={mutating}
            className="flex"
            style={
              isMobile
                ? inspectorOpen
                  ? INSPECTOR_DRAWER_STYLE
                  : HIDDEN_STYLE
                : undefined
            }
            onClose={() => {
              setDetailDrawer(null);
              if (isMobile) setInspectorOpen(false);
            }}
            onRetry={(input) =>
              runMutation(() =>
                client.retryOrchestratorTaskTurn(detail.id, input),
              )
            }
            onRerun={(input) =>
              runMutation(() =>
                client.rerunOrchestratorTaskFromEvent(detail.id, input),
              )
            }
            t={t}
            locale={locale}
          />
        ) : detail ? (
          <TaskInspector
            detail={detail}
            className="flex"
            style={
              isMobile
                ? inspectorOpen
                  ? INSPECTOR_DRAWER_STYLE
                  : HIDDEN_STYLE
                : undefined
            }
            onClose={isMobile ? () => setInspectorOpen(false) : undefined}
            busy={mutating}
            addAgentOpen={addAgentOpen}
            onPause={() =>
              runMutation(() => client.pauseOrchestratorTask(detail.id))
            }
            onResume={() =>
              runMutation(() => client.resumeOrchestratorTask(detail.id))
            }
            onArchive={() =>
              runMutation(async () => {
                await client.archiveCodingAgentTaskThread(detail.id);
                if (!showArchived) setSelectedId(null);
              })
            }
            onReopen={() =>
              runMutation(() => client.reopenCodingAgentTaskThread(detail.id))
            }
            onDelete={() =>
              runMutation(async () => {
                await client.deleteOrchestratorTask(detail.id);
                setSelectedId(null);
              })
            }
            onFork={() =>
              runMutation(async () => {
                const forked = await client.forkOrchestratorTask(detail.id);
                if (forked) setSelectedId(forked.id);
              })
            }
            onRestart={() => {
              const confirmed =
                typeof window === "undefined" ||
                window.confirm(
                  t("orchestrator.confirmRestart", {
                    defaultValue:
                      "Restart this task with a fresh worker? Active agents will be stopped first.",
                  }),
                );
              if (!confirmed) return;
              runMutation(() =>
                client.restartOrchestratorTask(detail.id, { stopActive: true }),
              );
            }}
            onRestartWithEditedPlan={(input) =>
              runMutation(() =>
                client.restartOrchestratorTaskWithEditedPlan(detail.id, input),
              )
            }
            onValidate={(passed) =>
              runMutation(() =>
                client.validateOrchestratorTask(detail.id, {
                  passed,
                  humanOverride: true,
                }),
              )
            }
            onSetPriority={(priority) =>
              runMutation(() =>
                client.updateOrchestratorTask(detail.id, { priority }),
              )
            }
            onToggleAddAgent={() => setAddAgentOpen((prev) => !prev)}
            onAddAgent={(input) =>
              runMutation(async () => {
                await client.addOrchestratorAgent(detail.id, input);
                setAddAgentOpen(false);
              })
            }
            onInspectSession={handleInspectSession}
            onStopAgent={(sessionId) =>
              runMutation(() =>
                client.stopOrchestratorAgent(detail.id, sessionId),
              )
            }
            onCopyLink={handleCopyLink}
            t={t}
            locale={locale}
          />
        ) : null}
      </div>
    </div>
  );
}
