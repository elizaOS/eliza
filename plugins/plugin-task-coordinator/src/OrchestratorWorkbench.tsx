import {
  Button,
  type CodingAgentAddAgentInput,
  type CodingAgentOrchestratorStatus,
  type CodingAgentTaskArtifactRecord,
  type CodingAgentTaskEventRecord,
  type CodingAgentTaskMessageRecord,
  type CodingAgentTaskSessionRecord,
  type CodingAgentTaskThread,
  type CodingAgentTaskThreadDetail,
  type CodingAgentTaskUsageSummary,
  client,
  EmptyWidgetState,
  useApp,
} from "@elizaos/ui";
import {
  Activity,
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  ChevronsUp,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePlay,
  CircleStop,
  CircleX,
  Copy,
  Gauge,
  GitFork,
  Layers,
  ListTodo,
  type LucideIcon,
  OctagonX,
  PanelRightOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  UserPlus,
  UserRound,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  formatClockTime,
  formatCompactNumber,
  formatIsoRelative,
  formatRelativeTime,
  formatUsd,
  stripAnsi,
} from "./view-format";

type Translate = (key: string, vars?: Record<string, unknown>) => string;
type TaskStatus = CodingAgentTaskThread["status"];
type TaskPriority = CodingAgentTaskThread["priority"];
type StatusFilter = "all" | TaskStatus;

const fallbackTranslate: Translate = (key, vars) =>
  String(vars?.defaultValue ?? key);

const TASK_LIST_LIMIT = 100;
const TIMELINE_PAGE_LIMIT = 50;
const POLL_INTERVAL_MS = 5_000;

const STATUS_ICON: Record<TaskStatus, LucideIcon> = {
  open: Circle,
  active: CirclePlay,
  waiting_on_user: UserRound,
  blocked: OctagonX,
  validating: CircleDashed,
  done: CircleCheck,
  failed: CircleX,
  archived: Archive,
  interrupted: CircleAlert,
};

const STATUS_TONE: Record<TaskStatus, string> = {
  open: "text-muted",
  active: "text-ok",
  waiting_on_user: "text-warn",
  blocked: "text-warn",
  validating: "text-accent",
  done: "text-ok",
  failed: "text-danger",
  archived: "text-muted",
  interrupted: "text-warn",
};

const STATUS_PULSE: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "active",
  "validating",
]);

const PRIORITY_ICON: Record<TaskPriority, LucideIcon | null> = {
  low: ChevronDown,
  normal: null,
  high: ChevronUp,
  urgent: ChevronsUp,
};

const PRIORITY_TONE: Record<TaskPriority, string> = {
  low: "text-muted",
  normal: "",
  high: "text-warn",
  urgent: "text-danger",
};

const SESSION_ICON: Record<string, LucideIcon> = {
  active: CirclePlay,
  running: CirclePlay,
  tool_running: CirclePlay,
  blocked: OctagonX,
  idle: Circle,
  completed: CircleCheck,
  stopped: CircleStop,
  error: CircleX,
  errored: CircleX,
};

const SESSION_TONE: Record<string, string> = {
  active: "text-ok",
  running: "text-ok",
  tool_running: "text-ok",
  blocked: "text-warn",
  idle: "text-muted",
  completed: "text-ok",
  stopped: "text-muted",
  error: "text-danger",
  errored: "text-danger",
};

const SESSION_PULSE: ReadonlySet<string> = new Set([
  "active",
  "running",
  "tool_running",
]);

const VERIFICATION_ICON: Record<
  CodingAgentTaskArtifactRecord["verificationStatus"],
  LucideIcon
> = {
  passed: CircleCheck,
  failed: CircleX,
  pending: CircleDashed,
  unknown: Circle,
};

const VERIFICATION_TONE: Record<
  CodingAgentTaskArtifactRecord["verificationStatus"],
  string
> = {
  passed: "text-ok",
  failed: "text-danger",
  pending: "text-warn",
  unknown: "text-muted",
};

const PLAN_STEP_ICON: Record<string, LucideIcon> = {
  done: CircleCheck,
  completed: CircleCheck,
  passed: CircleCheck,
  in_progress: CircleDashed,
  active: CircleDashed,
  running: CircleDashed,
  blocked: OctagonX,
  failed: CircleX,
  pending: Circle,
  todo: Circle,
};

const PLAN_STEP_TONE: Record<string, string> = {
  done: "text-ok",
  completed: "text-ok",
  passed: "text-ok",
  in_progress: "text-accent",
  active: "text-accent",
  running: "text-accent",
  blocked: "text-warn",
  failed: "text-danger",
  pending: "text-muted",
  todo: "text-muted",
};

const FILTER_OPTIONS: StatusFilter[] = [
  "all",
  "active",
  "blocked",
  "validating",
  "waiting_on_user",
  "interrupted",
  "open",
  "done",
  "failed",
];

const STATUS_LABEL_KEY: Record<TaskStatus, string> = {
  open: "orchestrator.status.open",
  active: "orchestrator.status.active",
  waiting_on_user: "orchestrator.status.waitingOnUser",
  blocked: "orchestrator.status.blocked",
  validating: "orchestrator.status.validating",
  done: "orchestrator.status.done",
  failed: "orchestrator.status.failed",
  archived: "orchestrator.status.archived",
  interrupted: "orchestrator.status.interrupted",
};

function labelStatus(status: TaskStatus, t: Translate): string {
  return t(STATUS_LABEL_KEY[status], {
    defaultValue: status.replace(/_/g, " "),
  });
}

function labelPriority(priority: TaskPriority, t: Translate): string {
  return t(`orchestrator.priority.${priority}`, { defaultValue: priority });
}

function StatusGlyph({
  status,
  paused,
  t,
  size = "h-3.5 w-3.5",
}: {
  status: TaskStatus;
  paused?: boolean;
  t: Translate;
  size?: string;
}) {
  const Icon = STATUS_ICON[status];
  const label = labelStatus(status, t);
  const pulse = STATUS_PULSE.has(status) && !paused ? " animate-pulse" : "";
  return (
    <span
      className="inline-flex shrink-0"
      title={label}
      aria-label={label}
      role="img"
    >
      <Icon className={`${size} ${STATUS_TONE[status]}${pulse}`} aria-hidden />
    </span>
  );
}

function PriorityGlyph({
  priority,
  t,
  size = "h-3.5 w-3.5",
}: {
  priority: TaskPriority;
  t: Translate;
  size?: string;
}) {
  const Icon = PRIORITY_ICON[priority];
  if (!Icon) return null;
  const label = labelPriority(priority, t);
  return (
    <span
      className="inline-flex shrink-0"
      title={label}
      aria-label={label}
      role="img"
    >
      <Icon className={`${size} ${PRIORITY_TONE[priority]}`} aria-hidden />
    </span>
  );
}

function SessionGlyph({
  status,
  t,
  size = "h-3.5 w-3.5",
}: {
  status: string;
  t: Translate;
  size?: string;
}) {
  const Icon = SESSION_ICON[status] ?? Circle;
  const tone = SESSION_TONE[status] ?? "text-muted";
  const label = labelSessionStatus(status, t);
  const pulse = SESSION_PULSE.has(status) ? " animate-pulse" : "";
  return (
    <span
      className="inline-flex shrink-0"
      title={label}
      aria-label={label}
      role="img"
    >
      <Icon className={`${size} ${tone}${pulse}`} aria-hidden />
    </span>
  );
}

function VerificationGlyph({
  status,
  t,
}: {
  status: CodingAgentTaskArtifactRecord["verificationStatus"];
  t: Translate;
}) {
  const Icon = VERIFICATION_ICON[status];
  const label = t(`orchestrator.verification.${status}`, {
    defaultValue: status,
  });
  return (
    <span
      className="inline-flex shrink-0"
      title={label}
      aria-label={label}
      role="img"
    >
      <Icon className={`h-3.5 w-3.5 ${VERIFICATION_TONE[status]}`} aria-hidden />
    </span>
  );
}

function PlanStepGlyph({ status, t }: { status: string; t: Translate }) {
  const key = status.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const Icon = PLAN_STEP_ICON[key] ?? Circle;
  const tone = PLAN_STEP_TONE[key] ?? "text-muted";
  const label = t(`orchestrator.planStatus.${key}`, {
    defaultValue: status.replace(/_/g, " "),
  });
  return (
    <span
      className="mt-px inline-flex shrink-0"
      title={label}
      aria-label={label}
      role="img"
    >
      <Icon className={`h-3.5 w-3.5 ${tone}`} aria-hidden />
    </span>
  );
}

const SENDER_LABEL_KEY: Record<
  CodingAgentTaskMessageRecord["senderKind"],
  { key: string; fallback: string }
> = {
  user: { key: "orchestrator.sender.user", fallback: "You" },
  orchestrator: {
    key: "orchestrator.sender.orchestrator",
    fallback: "Orchestrator",
  },
  sub_agent: { key: "orchestrator.sender.subAgent", fallback: "Sub-agent" },
  system: { key: "orchestrator.sender.system", fallback: "System" },
};

function labelSender(
  kind: CodingAgentTaskMessageRecord["senderKind"],
  t: Translate,
): string {
  const meta = SENDER_LABEL_KEY[kind];
  return t(meta.key, { defaultValue: meta.fallback });
}

/**
 * Resolve the display name for a timeline message's sender. Sub-agents render
 * their per-session label (the name they were spun up with); the orchestrator
 * renders the running agent's name (usually "Eliza"). Falls back to the generic
 * role label when no specific name is available.
 */
function resolveSenderName(
  message: CodingAgentTaskMessageRecord,
  sessionLabelById: Map<string, string>,
  mainAgentName: string | undefined,
  t: Translate,
): string {
  if (message.senderKind === "sub_agent") {
    const label = message.sessionId
      ? sessionLabelById.get(message.sessionId)?.trim()
      : undefined;
    return label || labelSender("sub_agent", t);
  }
  if (message.senderKind === "orchestrator") {
    return mainAgentName?.trim() || labelSender("orchestrator", t);
  }
  return labelSender(message.senderKind, t);
}

function getClientErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Merge timeline records by id and return them ascending by timestamp. */
function mergeById<T extends { id: string; timestamp: number }>(
  previous: T[],
  incoming: T[],
): T[] {
  if (incoming.length === 0) return previous;
  const byId = new Map<string, T>();
  for (const item of previous) byId.set(item.id, item);
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
}

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

// --- Voice/chat capability dispatch ----------------------------------------
// These ids are declared on the `/orchestrator` view and routed through the
// bundle's shared `interact` export so the agent can drive the workbench by
// voice or chat. Every handler maps 1:1 to a client method.

export const ORCHESTRATOR_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "orchestrator-status",
  "orchestrator-list-tasks",
  "orchestrator-open-task",
  "orchestrator-create-task",
  "orchestrator-pause-task",
  "orchestrator-resume-task",
  "orchestrator-pause-all",
  "orchestrator-resume-all",
  "orchestrator-delete-task",
  "orchestrator-fork-task",
  "orchestrator-update-task",
  "orchestrator-validate-task",
  "orchestrator-add-agent",
  "orchestrator-stop-agent",
  "orchestrator-send-message",
]);

function paramString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function paramPriority(value: unknown): TaskPriority | undefined {
  return value === "low" ||
    value === "normal" ||
    value === "high" ||
    value === "urgent"
    ? value
    : undefined;
}

function paramStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (entry): entry is string =>
      typeof entry === "string" && entry.trim() !== "",
  );
  return items.length > 0 ? items.map((entry) => entry.trim()) : undefined;
}

function requireTaskId(params?: Record<string, unknown>): string {
  const taskId = paramString(params?.taskId);
  if (!taskId) throw new Error("taskId is required for this capability.");
  return taskId;
}

export async function runOrchestratorCapability(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  switch (capability) {
    case "orchestrator-status":
      return client.getOrchestratorStatus();
    case "orchestrator-list-tasks":
      return client.listCodingAgentTaskThreads({
        includeArchived: params?.includeArchived === true,
        status: paramString(params?.status),
        search: paramString(params?.search),
        limit:
          typeof params?.limit === "number" ? params.limit : TASK_LIST_LIMIT,
      });
    case "orchestrator-open-task": {
      const taskId = paramString(params?.taskId);
      if (taskId) return client.getCodingAgentTaskThread(taskId);
      const [first] = await client.listCodingAgentTaskThreads({ limit: 1 });
      return first ? client.getCodingAgentTaskThread(first.id) : null;
    }
    case "orchestrator-create-task": {
      const title = paramString(params?.title);
      const goal = paramString(params?.goal);
      if (!title || !goal) {
        throw new Error("title and goal are required to create a task.");
      }
      return client.createOrchestratorTask({
        title,
        goal,
        originalRequest: paramString(params?.originalRequest),
        kind: paramString(params?.kind),
        priority: paramPriority(params?.priority),
        acceptanceCriteria: paramStringArray(params?.acceptanceCriteria),
      });
    }
    case "orchestrator-pause-task":
      return client.pauseOrchestratorTask(requireTaskId(params));
    case "orchestrator-resume-task":
      return client.resumeOrchestratorTask(requireTaskId(params));
    case "orchestrator-pause-all":
      return { paused: await client.pauseAllOrchestratorTasks() };
    case "orchestrator-resume-all":
      return { resumed: await client.resumeAllOrchestratorTasks() };
    case "orchestrator-delete-task":
      return {
        deleted: await client.deleteOrchestratorTask(requireTaskId(params)),
      };
    case "orchestrator-fork-task":
      return client.forkOrchestratorTask(requireTaskId(params), {
        title: paramString(params?.title),
        goal: paramString(params?.goal),
        priority: paramPriority(params?.priority),
        acceptanceCriteria: paramStringArray(params?.acceptanceCriteria),
      });
    case "orchestrator-update-task":
      return client.updateOrchestratorTask(requireTaskId(params), {
        title: paramString(params?.title),
        goal: paramString(params?.goal),
        summary: paramString(params?.summary),
        priority: paramPriority(params?.priority),
        acceptanceCriteria: paramStringArray(params?.acceptanceCriteria),
      });
    case "orchestrator-validate-task": {
      if (typeof params?.passed !== "boolean") {
        throw new Error("passed (boolean) is required to validate a task.");
      }
      return client.validateOrchestratorTask(requireTaskId(params), {
        passed: params.passed,
        summary: paramString(params?.summary),
        evidence: paramString(params?.evidence),
        verifier: paramString(params?.verifier),
        humanOverride: params?.humanOverride === true,
      });
    }
    case "orchestrator-add-agent":
      return client.addOrchestratorAgent(requireTaskId(params), {
        framework: paramString(params?.framework),
        providerSource: paramString(params?.providerSource),
        model: paramString(params?.model),
        workdir: paramString(params?.workdir),
        repo: paramString(params?.repo),
        label: paramString(params?.label),
        task: paramString(params?.task),
      });
    case "orchestrator-stop-agent": {
      const sessionId = paramString(params?.sessionId);
      if (!sessionId)
        throw new Error("sessionId is required to stop an agent.");
      return {
        stopped: await client.stopOrchestratorAgent(
          requireTaskId(params),
          sessionId,
        ),
      };
    }
    case "orchestrator-send-message": {
      const content = paramString(params?.content);
      if (!content) throw new Error("content is required to send a message.");
      return {
        sent: await client.postOrchestratorTaskMessage(
          requireTaskId(params),
          content,
        ),
      };
    }
    default:
      throw new Error(`Orchestrator view does not support "${capability}".`);
  }
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

function StatChip({
  label,
  value,
  tone = "neutral",
  icon,
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "warn" | "danger" | "accent";
  icon?: ReactNode;
}) {
  const toneClass =
    tone === "ok"
      ? "text-ok"
      : tone === "warn"
        ? "text-warn"
        : tone === "danger"
          ? "text-danger"
          : tone === "accent"
            ? "text-accent"
            : "text-txt";
  return (
    <div
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border/50 bg-bg-accent/30 px-2 py-1"
      title={label}
      aria-label={label}
    >
      {icon ? <span className="shrink-0 text-muted">{icon}</span> : null}
      <span className={`text-xs font-semibold tabular-nums ${toneClass}`}>
        {value}
      </span>
    </div>
  );
}

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
    <section className="rounded-lg border border-border/50 bg-bg-accent/20 p-2.5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
          {title}
        </h3>
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
  onNewTask,
  onPauseAll,
  onResumeAll,
  t,
  locale,
}: {
  status: CodingAgentOrchestratorStatus | null;
  busy: boolean;
  isMobile: boolean;
  onNewTask: () => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  t: Translate;
  locale?: string;
}) {
  const title = (
    <div className="flex shrink-0 items-center gap-2">
      <Layers className="h-4 w-4 text-accent" />
      <span className="text-sm font-semibold text-txt">
        {t("orchestrator.title", { defaultValue: "Orchestrator" })}
      </span>
    </div>
  );
  const chips = (
    <div
      className="flex items-center gap-1.5"
      style={
        isMobile
          ? { overflowX: "auto" }
          : { flex: "1 1 0%", flexWrap: "wrap" }
      }
    >
      <StatChip
        label={t("orchestrator.stat.tasks", { defaultValue: "Tasks" })}
        value={String(status?.taskCount ?? 0)}
        icon={<ListTodo className="h-3 w-3" />}
      />
      <StatChip
        label={t("orchestrator.stat.active", { defaultValue: "Active" })}
        value={String(status?.activeTaskCount ?? 0)}
        tone="ok"
        icon={<CirclePlay className="h-3 w-3" />}
      />
      <StatChip
        label={t("orchestrator.stat.blocked", { defaultValue: "Blocked" })}
        value={String(status?.blockedTaskCount ?? 0)}
        tone="warn"
        icon={<OctagonX className="h-3 w-3" />}
      />
      <StatChip
        label={t("orchestrator.stat.validating", {
          defaultValue: "Validating",
        })}
        value={String(status?.validatingTaskCount ?? 0)}
        tone="accent"
        icon={<CircleDashed className="h-3 w-3" />}
      />
      <StatChip
        label={t("orchestrator.stat.agents", { defaultValue: "Agents" })}
        value={`${status?.activeSessionCount ?? 0}/${status?.sessionCount ?? 0}`}
        icon={<Bot className="h-3 w-3" />}
      />
      {status ? (
        <StatChip
          label={t("orchestrator.stat.usage", { defaultValue: "Usage" })}
          value={
            isMobile
              ? renderTokens(status.usage, t, locale)
              : `${renderTokens(status.usage, t, locale)} · ${renderCost(status.usage, t, locale)}`
          }
          icon={<Gauge className="h-3 w-3" />}
        />
      ) : null}
    </div>
  );
  const pauseAllLabel = t("orchestrator.action.pauseAll", {
    defaultValue: "Pause all",
  });
  const resumeAllLabel = t("orchestrator.action.resumeAll", {
    defaultValue: "Resume all",
  });
  const newTaskLabel = t("orchestrator.action.newTask", {
    defaultValue: "New task",
  });
  const actions = (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !status?.activeTaskCount}
        onClick={onPauseAll}
        className="h-7 w-7 p-0"
        aria-label={pauseAllLabel}
        title={pauseAllLabel}
        data-testid="orchestrator-pause-all"
      >
        <Pause className="h-3.5 w-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || !status?.pausedTaskCount}
        onClick={onResumeAll}
        className="h-7 w-7 p-0"
        aria-label={resumeAllLabel}
        title={resumeAllLabel}
        data-testid="orchestrator-resume-all"
      >
        <Play className="h-3.5 w-3.5" />
      </Button>
      <Button
        size="sm"
        disabled={busy}
        onClick={onNewTask}
        className="h-7 w-7 p-0"
        aria-label={newTaskLabel}
        title={newTaskLabel}
        data-testid="orchestrator-new-task"
      >
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  if (isMobile) {
    return (
      <header className="flex flex-col gap-2 border-b border-border/60 bg-bg px-3 py-2">
        <div className="flex items-center gap-2">
          {title}
          {actions}
        </div>
        {chips}
      </header>
    );
  }

  return (
    <header className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-bg px-3 py-2">
      {title}
      {chips}
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
  return (
    <select
      value={active}
      onChange={(event) => onSelect(event.target.value as StatusFilter)}
      className={FIELD_CLASS}
      aria-label={t("orchestrator.filter.label", {
        defaultValue: "Filter by status",
      })}
      data-testid="orchestrator-filter"
    >
      {FILTER_OPTIONS.map((filter) => {
        const label =
          filter === "all"
            ? t("orchestrator.filter.all", { defaultValue: "All" })
            : labelStatus(filter, t);
        return (
          <option key={filter} value={filter}>
            {label} ({countFor(filter)})
          </option>
        );
      })}
    </select>
  );
}

function TaskRailItem({
  thread,
  selected,
  onSelect,
  t,
  locale,
}: {
  thread: CodingAgentTaskThread;
  selected: boolean;
  onSelect: (id: string) => void;
  t: Translate;
  locale?: string;
}) {
  const lastActivity =
    thread.latestActivityAt != null
      ? formatRelativeTime(thread.latestActivityAt, locale)
      : formatIsoRelative(
          thread.updatedAt,
          locale,
          t("orchestrator.unknown", { defaultValue: "—" }),
        );
  return (
    <div
      className={`rounded-lg border transition-colors ${
        selected
          ? "border-accent/50 bg-bg-hover/70"
          : "border-border/50 bg-bg-accent/30 hover:bg-bg-hover/40"
      }`}
      data-testid="orchestrator-task-item"
    >
      <button
        type="button"
        onClick={() => onSelect(thread.id)}
        className="flex w-full flex-col gap-1 p-2.5 text-left"
      >
        <div className="flex items-center gap-1.5">
          <StatusGlyph status={thread.status} paused={thread.paused} t={t} />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-txt">
            {thread.title}
          </span>
          {thread.paused ? (
            <Pause className="h-3 w-3 shrink-0 text-warn" />
          ) : null}
          <PriorityGlyph priority={thread.priority} t={t} />
        </div>
        <div className="flex items-center gap-2.5 text-2xs text-muted">
          <span className="flex items-center gap-0.5">
            <Bot className="h-3 w-3" />
            {thread.activeSessionCount}/{thread.sessionCount}
          </span>
          <span className="tabular-nums">
            {renderTokens(thread.usage, t, locale)}
          </span>
          <span className="ml-auto truncate">{lastActivity}</span>
        </div>
      </button>
    </div>
  );
}

function MessageEntry({
  message,
  senderName,
  locale,
}: {
  message: CodingAgentTaskMessageRecord;
  senderName: string;
  locale?: string;
}) {
  const text = stripAnsi(message.content);
  if (!text) return null;
  const isUser = message.senderKind === "user";
  // Your own messages read as "yours" by color + right-alignment, so the
  // explicit "You" label is redundant; everyone else keeps their name.
  const tone = isUser
    ? "bg-accent/20"
    : message.senderKind === "orchestrator"
      ? "bg-bg-accent/60"
      : "bg-bg-hover/60";
  return (
    <div
      className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
      data-testid="orchestrator-message"
    >
      <div
        className={`rounded-lg px-2.5 py-1.5 ${tone}`}
        style={{ maxWidth: "88%" }}
      >
        <div className="mb-0.5 flex items-center gap-2 text-2xs text-muted">
          {isUser ? null : (
            <span className="font-semibold tracking-tight text-txt/90">
              {senderName}
            </span>
          )}
          <span className="tabular-nums">
            {formatClockTime(message.timestamp, locale)}
          </span>
        </div>
        <pre className="whitespace-pre-wrap break-words font-sans text-xs text-txt">
          {text}
        </pre>
      </div>
    </div>
  );
}

function EventEntry({
  event,
  locale,
}: {
  event: CodingAgentTaskEventRecord;
  locale?: string;
}) {
  // Show the specific summary as the single line; the event type (e.g.
  // "agent spawned") only restates what the summary already says ("token-
  // exchange spawned"), so it's dropped unless there is no summary.
  const text = event.summary?.trim() || event.eventType.replace(/_/g, " ");
  return (
    <div
      className="flex items-center gap-2 px-1 text-2xs text-muted"
      data-testid="orchestrator-event"
    >
      <span className="h-px flex-1 bg-border/40" />
      <span
        className="min-w-0 shrink truncate font-medium"
        style={{ maxWidth: "72%" }}
      >
        {text}
      </span>
      <span className="shrink-0 tabular-nums">
        {formatClockTime(event.timestamp, locale)}
      </span>
      <span className="h-px flex-1 bg-border/40" />
    </div>
  );
}

function SubAgentCard({
  session,
  busy,
  onStop,
  t,
  locale,
}: {
  session: CodingAgentTaskSessionRecord;
  busy: boolean;
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
    t("orchestrator.noWorkspace", { defaultValue: "No workspace" });
  return (
    <div className="rounded-md border border-border/40 bg-bg/40 p-2">
      <div className="flex items-center gap-1.5">
        <SessionGlyph status={session.status} t={t} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-txt">
          {session.label}
        </span>
        {stoppable ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => onStop(session.sessionId)}
            className="flex items-center gap-0.5 rounded px-1 py-0.5 text-2xs text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
            data-testid="orchestrator-stop-agent"
            aria-label={t("orchestrator.action.stopAgent", {
              defaultValue: "Stop agent",
            })}
          >
            <CircleStop className="h-3 w-3" />
          </button>
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
          {formatTokenCount(
            session.usageState,
            session.totalTokens,
            t,
            locale,
          )}
        </span>
      </div>
      <div className="mt-0.5 truncate text-2xs text-muted/80">{workspace}</div>
    </div>
  );
}

/** Sub-agent status labels reuse task-status keys where they overlap and fall
 * back to the raw token otherwise (sessions carry framework-specific states). */
function labelSessionStatus(status: string, t: Translate): string {
  return t(`orchestrator.sessionStatus.${status}`, {
    defaultValue: status.replace(/_/g, " "),
  });
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
              <VerificationGlyph
                status={artifact.verificationStatus}
                t={t}
              />
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
  "w-full rounded-md border border-border/50 bg-bg px-2 py-1.5 text-xs text-txt outline-none transition-colors placeholder:text-muted focus:border-accent/50";

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <span className="mb-1 block text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
      {children}
    </span>
  );
}

function CreateTaskDialog({
  busy,
  onClose,
  onSubmit,
  t,
}: {
  busy: boolean;
  onClose: () => void;
  onSubmit: (input: {
    title: string;
    goal: string;
    priority: TaskPriority;
    acceptanceCriteria: string[];
  }) => void;
  t: Translate;
}) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("normal");
  const [criteria, setCriteria] = useState("");
  const canSubmit = title.trim() !== "" && goal.trim() !== "" && !busy;

  return (
    <div
      className="absolute inset-0 z-20 flex items-center justify-center bg-black/40 p-4"
      data-testid="orchestrator-create-dialog"
    >
      <div className="flex max-h-full w-full max-w-md flex-col gap-2.5 overflow-y-auto rounded-xl border border-border/60 bg-bg p-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-txt">
            {t("orchestrator.create.title", { defaultValue: "New task" })}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted transition-colors hover:bg-bg-hover/60"
            aria-label={t("orchestrator.action.close", {
              defaultValue: "Close",
            })}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <label>
          <FieldLabel>
            {t("orchestrator.create.taskTitle", { defaultValue: "Title" })}
          </FieldLabel>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className={FIELD_CLASS}
            placeholder={t("orchestrator.create.titlePlaceholder", {
              defaultValue: "Short, action-oriented name",
            })}
            data-testid="orchestrator-create-title"
          />
        </label>
        <label>
          <FieldLabel>
            {t("orchestrator.create.goal", { defaultValue: "Goal" })}
          </FieldLabel>
          <textarea
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={4}
            className={`${FIELD_CLASS} resize-none`}
            placeholder={t("orchestrator.create.goalPlaceholder", {
              defaultValue:
                "What must be true when this is done? Sub-agents inherit this goal.",
            })}
            data-testid="orchestrator-create-goal"
          />
        </label>
        <label>
          <FieldLabel>
            {t("orchestrator.create.priority", { defaultValue: "Priority" })}
          </FieldLabel>
          <select
            value={priority}
            onChange={(event) =>
              setPriority(event.target.value as TaskPriority)
            }
            className={FIELD_CLASS}
            data-testid="orchestrator-create-priority"
          >
            <option value="low">{labelPriority("low", t)}</option>
            <option value="normal">{labelPriority("normal", t)}</option>
            <option value="high">{labelPriority("high", t)}</option>
            <option value="urgent">{labelPriority("urgent", t)}</option>
          </select>
        </label>
        <label>
          <FieldLabel>
            {t("orchestrator.create.acceptance", {
              defaultValue: "Acceptance criteria (one per line)",
            })}
          </FieldLabel>
          <textarea
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
            rows={3}
            className={`${FIELD_CLASS} resize-none`}
            placeholder={t("orchestrator.create.acceptancePlaceholder", {
              defaultValue: "Tests pass\nNo type errors\nScreenshots verified",
            })}
            data-testid="orchestrator-create-acceptance"
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            className="h-7 px-2.5 text-xs-tight"
          >
            {t("orchestrator.action.cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button
            size="sm"
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({
                title: title.trim(),
                goal: goal.trim(),
                priority,
                acceptanceCriteria: criteria
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line !== ""),
              })
            }
            className="h-7 px-2.5 text-xs-tight"
            data-testid="orchestrator-create-submit"
          >
            {t("orchestrator.action.createTask", {
              defaultValue: "Create task",
            })}
          </Button>
        </div>
      </div>
    </div>
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

  return (
    <div className="mt-1.5 space-y-1.5 rounded-md border border-border/50 bg-bg/40 p-2">
      <input
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        className={FIELD_CLASS}
        placeholder={fieldLabels.label}
        aria-label={fieldLabels.label}
        data-testid="orchestrator-add-agent-label"
      />
      <div className="flex gap-1.5">
        <input
          value={framework}
          onChange={(event) => setFramework(event.target.value)}
          className={FIELD_CLASS}
          placeholder={fieldLabels.framework}
          aria-label={fieldLabels.framework}
        />
        <input
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className={FIELD_CLASS}
          placeholder={fieldLabels.model}
          aria-label={fieldLabels.model}
        />
      </div>
      <input
        value={workdir}
        onChange={(event) => setWorkdir(event.target.value)}
        className={FIELD_CLASS}
        placeholder={fieldLabels.workdir}
        aria-label={fieldLabels.workdir}
      />
      <input
        value={repo}
        onChange={(event) => setRepo(event.target.value)}
        className={FIELD_CLASS}
        placeholder={fieldLabels.repo}
        aria-label={fieldLabels.repo}
      />
      <textarea
        value={task}
        onChange={(event) => setTask(event.target.value)}
        rows={2}
        className={`${FIELD_CLASS} resize-none`}
        placeholder={fieldLabels.task}
        aria-label={fieldLabels.task}
      />
      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={onClose}
          className="h-6 px-2 text-2xs"
        >
          {t("orchestrator.action.cancel", { defaultValue: "Cancel" })}
        </Button>
        <Button
          size="sm"
          disabled={busy}
          onClick={() =>
            onSubmit({
              label: label.trim() || undefined,
              framework: framework.trim() || undefined,
              model: model.trim() || undefined,
              workdir: workdir.trim() || undefined,
              repo: repo.trim() || undefined,
              task: task.trim() || undefined,
            })
          }
          className="h-6 px-2 text-2xs"
          data-testid="orchestrator-add-agent-submit"
        >
          {t("orchestrator.action.spawn", { defaultValue: "Spawn agent" })}
        </Button>
      </div>
    </div>
  );
}

function ControlButton({
  icon,
  label,
  onClick,
  disabled,
  tone = "neutral",
  testId,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled: boolean;
  tone?: "neutral" | "danger";
  testId?: string;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`flex items-center justify-center rounded-md border border-border/50 p-1.5 transition-colors disabled:opacity-50 ${
        tone === "danger"
          ? "text-muted hover:bg-danger/10 hover:text-danger"
          : "text-muted hover:bg-bg-hover/60 hover:text-txt"
      }`}
      data-testid={testId}
    >
      {icon}
    </button>
  );
}

function TaskInspector({
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
  onValidate,
  onSetPriority,
  onToggleAddAgent,
  onAddAgent,
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
  onValidate: (passed: boolean) => void;
  onSetPriority: (priority: TaskPriority) => void;
  onToggleAddAgent: () => void;
  onAddAgent: (input: CodingAgentAddAgentInput) => void;
  onStopAgent: (sessionId: string) => void;
  onCopyLink: () => void;
  t: Translate;
  locale?: string;
}) {
  const plan = normalizePlan(detail.currentPlan);
  const sessions = [...detail.sessions].sort(
    (a, b) => b.lastActivityAt - a.lastActivityAt,
  );
  const artifacts = [...detail.artifacts].reverse().slice(0, 12);
  const archived = detail.status === "archived";
  const terminal =
    archived || detail.status === "done" || detail.status === "failed";
  const providerPolicyLine = detail.providerPolicy
    ? [
        detail.providerPolicy.preferredFramework,
        detail.providerPolicy.providerSource,
        detail.providerPolicy.model,
      ]
        .filter((part): part is string => Boolean(part))
        .join(" · ")
    : "";

  return (
    <div
      className={`shrink-0 flex-col gap-2.5 overflow-y-auto border-l border-border/60 bg-bg p-2.5 ${className ?? "flex w-80"}`}
      style={style}
      data-testid="orchestrator-inspector"
    >
      {onClose ? (
        <div className="flex items-center justify-between">
          <h3 className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
            {t("orchestrator.inspector.title", { defaultValue: "Details" })}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="-mr-1 rounded p-1 text-muted transition-colors hover:bg-bg-hover/60 hover:text-txt"
            aria-label={t("orchestrator.action.closeDetails", {
              defaultValue: "Close details",
            })}
            data-testid="orchestrator-close-inspector"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {detail.status === "validating" ? (
          <>
            <ControlButton
              icon={<Check className="h-3 w-3" />}
              label={t("orchestrator.action.approve", {
                defaultValue: "Approve",
              })}
              onClick={() => onValidate(true)}
              disabled={busy}
              testId="orchestrator-approve"
            />
            <ControlButton
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
            icon={<RotateCcw className="h-3 w-3" />}
            label={t("orchestrator.action.reopen", { defaultValue: "Reopen" })}
            onClick={onReopen}
            disabled={busy}
            testId="orchestrator-reopen"
          />
        ) : terminal ? null : detail.paused ? (
          <ControlButton
            icon={<Play className="h-3 w-3" />}
            label={t("orchestrator.action.resume", { defaultValue: "Resume" })}
            onClick={onResume}
            disabled={busy}
            testId="orchestrator-inspector-resume"
          />
        ) : (
          <ControlButton
            icon={<Pause className="h-3 w-3" />}
            label={t("orchestrator.action.pause", { defaultValue: "Pause" })}
            onClick={onPause}
            disabled={busy}
            testId="orchestrator-inspector-pause"
          />
        )}
        {archived ? null : (
          <ControlButton
            icon={<Archive className="h-3 w-3" />}
            label={t("orchestrator.action.archive", {
              defaultValue: "Archive",
            })}
            onClick={onArchive}
            disabled={busy}
            testId="orchestrator-inspector-archive"
          />
        )}
        <ControlButton
          icon={<GitFork className="h-3 w-3" />}
          label={t("orchestrator.action.fork", { defaultValue: "Fork" })}
          onClick={onFork}
          disabled={busy}
          testId="orchestrator-fork"
        />
        {archived ? null : (
          <ControlButton
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
          icon={<Copy className="h-3 w-3" />}
          label={t("orchestrator.action.copyLink", {
            defaultValue: "Copy link",
          })}
          onClick={onCopyLink}
          disabled={busy}
          testId="orchestrator-copy-link"
        />
        {terminal ? null : (
          <select
            aria-label={t("orchestrator.action.setPriority", {
              defaultValue: "Set priority",
            })}
            value={detail.priority}
            disabled={busy}
            onChange={(event) => {
              const next = paramPriority(event.target.value);
              if (next && next !== detail.priority) onSetPriority(next);
            }}
            className="rounded-md border border-border/50 bg-transparent px-2 py-1 text-2xs text-muted transition-colors hover:bg-bg-hover/60 hover:text-txt disabled:opacity-50"
            data-testid="orchestrator-priority-select"
          >
            <option value="low">{labelPriority("low", t)}</option>
            <option value="normal">{labelPriority("normal", t)}</option>
            <option value="high">{labelPriority("high", t)}</option>
            <option value="urgent">{labelPriority("urgent", t)}</option>
          </select>
        )}
        <ControlButton
          icon={<Trash2 className="h-3 w-3" />}
          label={t("orchestrator.action.delete", { defaultValue: "Delete" })}
          onClick={onDelete}
          disabled={busy}
          tone="danger"
          testId="orchestrator-delete"
        />
      </div>

      {addAgentOpen ? (
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
                onStop={onStopAgent}
                t={t}
                locale={locale}
              />
            ))}
          </div>
        )}
      </InspectorSection>

      {plan ? <PlanSection plan={plan} t={t} /> : null}
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

function readInitialTaskId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("task");
}

const MOBILE_QUERY = "(max-width: 767px)";

// The view bundle ships no CSS — it borrows the host stylesheet, which never
// generates the plugin's responsive (`md:`) variants. So responsiveness is
// driven in JS via matchMedia and applied with always-present classes + inline
// styles instead of breakpoint utilities.
function useIsMobile(): boolean {
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
const INSPECTOR_DRAWER_STYLE: CSSProperties = {
  position: "absolute",
  insetBlock: 0,
  right: 0,
  zIndex: 30,
  width: "86%",
  maxWidth: "22rem",
  boxShadow: "0 10px 30px rgba(0, 0, 0, 0.45)",
};

const HIDDEN_STYLE: CSSProperties = { display: "none" };

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

  if (isMobile) {
    return (
      <div className="border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="-ml-1 shrink-0 rounded p-1 text-muted transition-colors hover:bg-bg-hover/60 hover:text-txt"
            aria-label={t("orchestrator.action.backToList", {
              defaultValue: "Back to tasks",
            })}
            data-testid="orchestrator-back"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          {statusDot}
          {title}
          <button
            type="button"
            onClick={onOpenInspector}
            className="shrink-0 rounded-md border border-border/50 p-1 text-muted transition-colors hover:bg-bg-hover/60 hover:text-txt"
            aria-label={detailsLabel}
            title={detailsLabel}
            data-testid="orchestrator-open-inspector"
          >
            <PanelRightOpen className="h-4 w-4" aria-hidden />
          </button>
        </div>
        {pausedBadge ? (
          <div className="mt-1.5 flex items-center gap-1.5">{pausedBadge}</div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
      {statusDot}
      {title}
      {pausedBadge}
    </div>
  );
}

export function OrchestratorWorkbench() {
  const app = useApp() as ReturnType<typeof useApp> | undefined;
  const t = app?.t ?? fallbackTranslate;
  const locale =
    typeof app?.uiLanguage === "string" ? app.uiLanguage : undefined;
  const copyToClipboard = app?.copyToClipboard;
  const mainAgentName =
    typeof app?.agentStatus?.agentName === "string"
      ? app.agentStatus.agentName
      : undefined;

  const [status, setStatus] = useState<CodingAgentOrchestratorStatus | null>(
    null,
  );
  const [tasks, setTasks] = useState<CodingAgentTaskThread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(
    readInitialTaskId,
  );
  const [detail, setDetail] = useState<CodingAgentTaskThreadDetail | null>(
    null,
  );
  const [messages, setMessages] = useState<CodingAgentTaskMessageRecord[]>([]);
  const [messageCursor, setMessageCursor] = useState<string | null>(null);
  const [events, setEvents] = useState<CodingAgentTaskEventRecord[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showArchived, setShowArchived] = useState(false);
  const [composer, setComposer] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [addAgentOpen, setAddAgentOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const isMobile = useIsMobile();
  const deferredSearch = useDeferredValue(search.trim());
  const detailReqRef = useRef(0);
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;

  const fetchTasksAndStatus = useCallback(
    async (silent: boolean) => {
      if (!silent) setLoading(true);
      try {
        const [nextStatus, nextTasks] = await Promise.all([
          client.getOrchestratorStatus(),
          client.listCodingAgentTaskThreads({
            includeArchived: showArchived,
            status: statusFilter === "all" ? undefined : statusFilter,
            search: deferredSearch || undefined,
            limit: TASK_LIST_LIMIT,
          }),
        ]);
        setStatus(nextStatus);
        setTasks(nextTasks);
        setLoadError(null);
      } catch (error) {
        if (!silent) {
          setLoadError(
            getClientErrorMessage(
              error,
              t("orchestrator.loadFailed", {
                defaultValue: "Failed to load orchestrator state.",
              }),
            ),
          );
        }
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [deferredSearch, showArchived, statusFilter, t],
  );

  const fetchDetail = useCallback(async (id: string, reset: boolean) => {
    const token = ++detailReqRef.current;
    const [nextDetail, messagePage, eventPage] = await Promise.all([
      client.getCodingAgentTaskThread(id),
      client.listOrchestratorTaskMessages(id, { limit: TIMELINE_PAGE_LIMIT }),
      client.listOrchestratorTaskEvents(id, { limit: TIMELINE_PAGE_LIMIT }),
    ]);
    if (token !== detailReqRef.current) return;
    setDetail(nextDetail);
    if (reset) {
      setMessages(mergeById([], messagePage.items));
      setMessageCursor(messagePage.nextCursor);
      setEvents(mergeById([], eventPage.items));
    } else {
      setMessages((prev) => mergeById(prev, messagePage.items));
      setEvents((prev) => mergeById(prev, eventPage.items));
    }
  }, []);

  useEffect(() => {
    void fetchTasksAndStatus(false);
    const timer = window.setInterval(
      () => void fetchTasksAndStatus(true),
      POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [fetchTasksAndStatus]);

  useEffect(() => {
    // Reset transient per-task UI (mobile inspector drawer, add-agent form)
    // whenever the selection changes so a freshly opened task starts clean.
    setInspectorOpen(false);
    setAddAgentOpen(false);
    if (!selectedId) {
      setDetail(null);
      setMessages([]);
      setEvents([]);
      setMessageCursor(null);
      return;
    }
    void fetchDetail(selectedId, true).catch(() => {});
    const timer = window.setInterval(
      () => void fetchDetail(selectedId, false).catch(() => {}),
      POLL_INTERVAL_MS,
    );
    return () => window.clearInterval(timer);
  }, [selectedId, fetchDetail]);

  const runMutation = useCallback(
    async (fn: () => Promise<unknown>) => {
      setMutating(true);
      setActionError(null);
      try {
        await fn();
        await fetchTasksAndStatus(true);
        const current = selectedIdRef.current;
        if (current) await fetchDetail(current, false).catch(() => {});
      } catch (error) {
        setActionError(
          getClientErrorMessage(
            error,
            t("orchestrator.actionFailed", { defaultValue: "Action failed." }),
          ),
        );
      } finally {
        setMutating(false);
      }
    },
    [fetchTasksAndStatus, fetchDetail, t],
  );

  const loadOlderMessages = useCallback(async () => {
    const current = selectedIdRef.current;
    if (!current || !messageCursor) return;
    const page = await client.listOrchestratorTaskMessages(current, {
      cursor: messageCursor,
      limit: TIMELINE_PAGE_LIMIT,
    });
    setMessages((prev) => mergeById(prev, page.items));
    setMessageCursor(page.nextCursor);
  }, [messageCursor]);

  const handleSend = useCallback(() => {
    const current = selectedIdRef.current;
    const content = composer.trim();
    if (!current || !content) return;
    void runMutation(async () => {
      const delivered = await client.postOrchestratorTaskMessage(
        current,
        content,
      );
      if (!delivered) {
        throw new Error(
          t("orchestrator.messageDeliveryFailed", {
            defaultValue: "Message was recorded, but no active agent accepted it.",
          }),
        );
      }
      setComposer("");
    });
  }, [composer, runMutation, t]);

  const handleCreate = useCallback(
    (input: {
      title: string;
      goal: string;
      priority: TaskPriority;
      acceptanceCriteria: string[];
    }) => {
      void runMutation(async () => {
        const created = await client.createOrchestratorTask(input);
        setCreateOpen(false);
        setSelectedId(created.id);
      });
    },
    [runMutation],
  );

  const handleCopyLink = useCallback(() => {
    const current = selectedIdRef.current;
    if (!current || !copyToClipboard || typeof window === "undefined") return;
    const url = `${window.location.origin}/orchestrator?task=${encodeURIComponent(current)}`;
    void copyToClipboard(url);
  }, [copyToClipboard]);

  const timeline = useMemo(() => {
    const items: Array<
      | { kind: "message"; at: number; message: CodingAgentTaskMessageRecord }
      | { kind: "event"; at: number; event: CodingAgentTaskEventRecord }
    > = [];
    for (const message of messages) {
      items.push({ kind: "message", at: message.timestamp, message });
    }
    for (const event of events) {
      items.push({ kind: "event", at: event.timestamp, event });
    }
    return items.sort((a, b) => a.at - b.at);
  }, [messages, events]);

  const sessionLabelById = useMemo(() => {
    const map = new Map<string, string>();
    for (const session of detail?.sessions ?? []) {
      const label = session.label?.trim();
      if (session.sessionId && label) map.set(session.sessionId, label);
    }
    return map;
  }, [detail?.sessions]);

  const viewState = JSON.stringify({
    selectedId,
    taskCount: status?.taskCount ?? tasks.length,
    activeTaskCount: status?.activeTaskCount ?? 0,
    statusFilter,
    showArchived,
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
        onNewTask={() => setCreateOpen(true)}
        onPauseAll={() => runMutation(() => client.pauseAllOrchestratorTasks())}
        onResumeAll={() =>
          runMutation(() => client.resumeAllOrchestratorTasks())
        }
        t={t}
        locale={locale}
      />

      {loadError ? (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger">
          {loadError}
        </div>
      ) : null}
      {actionError ? (
        <div className="border-b border-danger/30 bg-danger/10 px-3 py-1.5 text-xs text-danger">
          {actionError}
        </div>
      ) : null}

      <div className="relative flex min-h-0 flex-1">
        {/* Left rail — full-width list on mobile, fixed rail on desktop.
            Hidden on mobile once a task is open (master-detail navigation). */}
        <aside
          className={`shrink-0 flex-col border-r border-border/60 bg-bg ${
            isMobile ? (selectedId ? "hidden" : "flex w-full") : "flex w-72"
          }`}
          data-testid="orchestrator-rail"
        >
          <div className="space-y-2 border-b border-border/50 p-2.5">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("orchestrator.searchPlaceholder", {
                defaultValue: "Search tasks",
              })}
              className={FIELD_CLASS}
              data-testid="orchestrator-search"
            />
            <FilterSelect
              status={status}
              active={statusFilter}
              onSelect={setStatusFilter}
              t={t}
            />
            <label className="flex items-center gap-1.5 text-2xs text-muted">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
                className="h-3 w-3"
                style={{ accentColor: "var(--accent)" }}
                data-testid="orchestrator-show-archived"
              />
              {t("orchestrator.showArchived", {
                defaultValue: "Show archived",
              })}
            </label>
          </div>
          <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
            {tasks.length === 0 ? (
              loading ? (
                <p className="p-2 text-xs text-muted">
                  {t("orchestrator.loadingTasks", {
                    defaultValue: "Loading tasks…",
                  })}
                </p>
              ) : (
                <EmptyWidgetState
                  icon={<Activity className="h-8 w-8" />}
                  title={t("orchestrator.empty.title", {
                    defaultValue: "No tasks yet",
                  })}
                />
              )
            ) : (
              tasks.map((thread) => (
                <TaskRailItem
                  key={thread.id}
                  thread={thread}
                  selected={thread.id === selectedId}
                  onSelect={(id) =>
                    setSelectedId((prev) => (prev === id ? null : id))
                  }
                  t={t}
                  locale={locale}
                />
              ))
            )}
          </div>
        </aside>

        {/* Center timeline — hidden on mobile until a task is selected. */}
        <main
          className={`min-w-0 flex-1 flex-col bg-bg-accent/10 ${
            isMobile ? (selectedId ? "flex" : "hidden") : "flex"
          }`}
          data-testid="orchestrator-timeline"
        >
          {detail ? (
            <>
              <TimelineHeader
                detail={detail}
                isMobile={isMobile}
                onBack={() => setSelectedId(null)}
                onOpenInspector={() => setInspectorOpen(true)}
                t={t}
              />
              <div
                className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3"
                data-testid="orchestrator-message-list"
              >
                {messageCursor ? (
                  <div className="flex justify-center">
                    <button
                      type="button"
                      onClick={() => void loadOlderMessages()}
                      className="flex items-center gap-1 rounded-full border border-border/50 px-2.5 py-0.5 text-2xs text-muted transition-colors hover:bg-bg-hover/50"
                      data-testid="orchestrator-load-older"
                    >
                      <ArrowDownToLine className="h-3 w-3" />
                      {t("orchestrator.loadOlder", {
                        defaultValue: "Load older",
                      })}
                    </button>
                  </div>
                ) : null}
                {timeline.length === 0 ? (
                  <p className="p-4 text-center text-xs text-muted">
                    {t("orchestrator.noMessages", {
                      defaultValue: "No messages yet.",
                    })}
                  </p>
                ) : (
                  timeline.map((item) =>
                    item.kind === "message" ? (
                      <MessageEntry
                        key={item.message.id}
                        message={item.message}
                        senderName={resolveSenderName(
                          item.message,
                          sessionLabelById,
                          mainAgentName,
                          t,
                        )}
                        locale={locale}
                      />
                    ) : (
                      <EventEntry
                        key={item.event.id}
                        event={item.event}
                        locale={locale}
                      />
                    ),
                  )
                )}
              </div>
              <div className="border-t border-border/50 p-2.5">
                <div className="flex items-end gap-2">
                  <textarea
                    value={composer}
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        handleSend();
                      }
                    }}
                    rows={1}
                    placeholder={t("orchestrator.composerPlaceholder", {
                      defaultValue: "Message the orchestrator…",
                    })}
                    className={`${FIELD_CLASS} max-h-32 resize-none`}
                    data-testid="orchestrator-composer"
                  />
                  <Button
                    size="sm"
                    disabled={mutating || composer.trim() === ""}
                    onClick={handleSend}
                    className="h-8 w-8 shrink-0 p-0"
                    aria-label={t("orchestrator.action.send", {
                      defaultValue: "Send",
                    })}
                    title={t("orchestrator.action.send", {
                      defaultValue: "Send",
                    })}
                    data-testid="orchestrator-send"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </>
          ) : selectedId ? (
            <>
              {isMobile ? (
                <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setSelectedId(null)}
                    className="-ml-1 shrink-0 rounded p-1 text-muted transition-colors hover:bg-bg-hover/60 hover:text-txt"
                    aria-label={t("orchestrator.action.backToList", {
                      defaultValue: "Back to tasks",
                    })}
                    data-testid="orchestrator-back-loading"
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </button>
                  <span className="text-sm font-medium text-muted">
                    {t("orchestrator.loadingTask", {
                      defaultValue: "Loading task…",
                    })}
                  </span>
                </div>
              ) : null}
              <div className="flex flex-1 items-center justify-center p-6">
                <p className="text-xs text-muted">
                  {t("orchestrator.loadingTask", {
                    defaultValue: "Loading task…",
                  })}
                </p>
              </div>
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyWidgetState
                icon={<Layers className="h-8 w-8" />}
                title={t("orchestrator.noSelection", {
                  defaultValue: "Select a task to inspect its room",
                })}
              />
            </div>
          )}
        </main>

        {/* Right inspector — inline pane on desktop, slide-over drawer on
            mobile (toggled by the Details button in the timeline header). */}
        {detail && isMobile && inspectorOpen ? (
          <button
            type="button"
            aria-label={t("orchestrator.action.closeDetails", {
              defaultValue: "Close details",
            })}
            onClick={() => setInspectorOpen(false)}
            className="absolute inset-0 z-20 bg-black/40"
            data-testid="orchestrator-inspector-backdrop"
          />
        ) : null}
        {detail ? (
          <TaskInspector
            detail={detail}
            className={isMobile ? "flex" : "flex w-80"}
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

      {createOpen ? (
        <CreateTaskDialog
          busy={mutating}
          onClose={() => setCreateOpen(false)}
          onSubmit={handleCreate}
          t={t}
        />
      ) : null}
    </div>
  );
}
