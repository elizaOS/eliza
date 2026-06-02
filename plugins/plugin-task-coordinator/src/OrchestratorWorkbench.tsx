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
  useApp,
} from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
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
  type UIEvent,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildConversation,
  ConversationBlockView,
} from "./orchestrator-stream";
import {
  formatCompactNumber,
  formatIsoRelative,
  formatRelativeTime,
  formatUsd,
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
/** While a task has a working agent, poll its room fast so the conversation,
 * tool calls, and tokens stream in near-live instead of lurching every 5s. */
const ACTIVE_POLL_INTERVAL_MS = 1_500;

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
      <Icon
        className={`h-3.5 w-3.5 ${VERIFICATION_TONE[status]}`}
        aria-hidden
      />
    </span>
  );
}

function PlanStepGlyph({ status, t }: { status: string; t: Translate }) {
  const key = status
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
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

/** A vertical hairline divider between header summary segments (the token kit
 * has no Separator export, so this is a thin local primitive). */
function HeaderDivider() {
  return <span aria-hidden className="h-3.5 w-px shrink-0 bg-border" />;
}

/** One labeled count in the header summary — a baseline-aligned number + tiny
 * uppercase label, no pill/border (replaces the old cryptic icon chips). */
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
      <span className="text-2xs uppercase tracking-[0.08em] text-muted">
        {label}
      </span>
    </span>
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
      <span className="text-sm font-semibold tracking-tight text-txt-strong">
        {t("orchestrator.title", { defaultValue: "Orchestrator" })}
      </span>
    </div>
  );
  // Calm labeled summary: total tasks always, then only the non-zero semantic
  // counts — reads "12 tasks · 1 active · 3 done", not a six-pill debug strip.
  const summary = (
    <div
      className="flex min-w-0 items-center gap-2.5 overflow-x-auto"
      style={isMobile ? undefined : { flex: "1 1 0%" }}
    >
      <HeaderStat value={String(status?.taskCount ?? 0)} label="tasks" />
      {status?.activeTaskCount ? (
        <>
          <HeaderDivider />
          <HeaderStat
            value={String(status.activeTaskCount)}
            label="active"
            toneClass="text-ok"
          />
        </>
      ) : null}
      {status?.blockedTaskCount ? (
        <>
          <HeaderDivider />
          <HeaderStat
            value={String(status.blockedTaskCount)}
            label="blocked"
            toneClass="text-warn"
          />
        </>
      ) : null}
      {status?.validatingTaskCount ? (
        <>
          <HeaderDivider />
          <HeaderStat
            value={String(status.validatingTaskCount)}
            label="validating"
            toneClass="text-accent"
          />
        </>
      ) : null}
      {status?.activeSessionCount ? (
        <>
          <HeaderDivider />
          <HeaderStat
            value={`${status.activeSessionCount}/${status.sessionCount}`}
            label="agents"
          />
        </>
      ) : null}
    </div>
  );
  const usageReadout = status ? (
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
  const newTaskLabel = t("orchestrator.action.newTask", {
    defaultValue: "New task",
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
  const { ref: newTaskRef, agentProps: newTaskAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "header-new-task",
      role: "button",
      label: newTaskLabel,
      group: "orchestrator-header",
      description: "Open the create-task dialog",
    });
  const actions = (
    <div className="ml-auto flex shrink-0 items-center gap-1.5">
      <Button
        ref={pauseAllRef}
        variant="ghost"
        size="sm"
        disabled={busy || !status?.activeTaskCount}
        onClick={onPauseAll}
        className="h-7 w-7 p-0"
        aria-label={pauseAllLabel}
        title={pauseAllLabel}
        data-testid="orchestrator-pause-all"
        {...pauseAllAgentProps}
      >
        <Pause className="h-3.5 w-3.5" />
      </Button>
      <Button
        ref={resumeAllRef}
        variant="ghost"
        size="sm"
        disabled={busy || !status?.pausedTaskCount}
        onClick={onResumeAll}
        className="h-7 w-7 p-0"
        aria-label={resumeAllLabel}
        title={resumeAllLabel}
        data-testid="orchestrator-resume-all"
        {...resumeAllAgentProps}
      >
        <Play className="h-3.5 w-3.5" />
      </Button>
      <Button
        ref={newTaskRef}
        size="sm"
        disabled={busy}
        onClick={onNewTask}
        className="h-7 gap-1.5 px-2.5 text-xs-tight font-semibold"
        aria-label={newTaskLabel}
        title={newTaskLabel}
        data-testid="orchestrator-new-task"
        {...newTaskAgentProps}
      >
        <Plus className="h-3.5 w-3.5" />
        {newTaskLabel}
      </Button>
    </div>
  );

  if (isMobile) {
    return (
      <header className="flex flex-col gap-2 border-b border-border/50 bg-bg px-4 py-2.5">
        <div className="flex items-center gap-2">
          {title}
          {actions}
        </div>
        <div className="flex items-center justify-between gap-2">
          {summary}
          {usageReadout}
        </div>
      </header>
    );
  }

  return (
    <header className="flex items-center gap-3 border-b border-border/50 bg-bg px-4 py-2.5">
      {title}
      {summary}
      {usageReadout}
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
  const { ref, agentProps } = useAgentElement<HTMLSelectElement>({
    id: "rail-filter-status",
    role: "select",
    label: t("orchestrator.filter.label", {
      defaultValue: "Filter by status",
    }),
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
  return (
    <select
      ref={ref}
      value={active}
      onChange={(event) => onSelect(event.target.value as StatusFilter)}
      className={FIELD_CLASS}
      aria-label={t("orchestrator.filter.label", {
        defaultValue: "Filter by status",
      })}
      data-testid="orchestrator-filter"
      {...agentProps}
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
  // A left accent bar surfaces in-progress/selected at a glance without parsing
  // the small status glyph. Idle rows are borderless (hover-fill only) so the
  // rail reads as a list, not a stack of boxes.
  const barTone = selected
    ? "before:bg-accent"
    : thread.status === "active"
      ? "before:bg-ok"
      : thread.status === "validating"
        ? "before:bg-accent"
        : thread.status === "blocked" || thread.status === "waiting_on_user"
          ? "before:bg-warn"
          : "before:bg-transparent";
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `task-rail-${thread.id}`,
    role: "list-item",
    label: thread.title,
    group: "orchestrator-rail",
    status: selected ? "active" : "inactive",
    description: `Open the "${thread.title}" task`,
  });
  return (
    <div
      className={`relative rounded-sm transition-colors before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:content-[''] ${barTone} ${
        selected ? "bg-accent-subtle" : "hover:bg-surface"
      }`}
      data-testid="orchestrator-task-item"
    >
      <button
        ref={ref}
        type="button"
        onClick={() => onSelect(thread.id)}
        className="flex w-full flex-col gap-0.5 px-2.5 py-2 pl-3 text-left"
        aria-current={selected ? "true" : undefined}
        {...agentProps}
      >
        <div className="flex items-center gap-1.5">
          <StatusGlyph status={thread.status} paused={thread.paused} t={t} />
          <span
            className={`min-w-0 flex-1 truncate text-xs-tight font-medium ${
              selected ? "text-txt-strong" : "text-txt"
            }`}
          >
            {thread.title}
          </span>
          {thread.paused ? (
            <Pause className="h-3 w-3 shrink-0 text-warn" />
          ) : null}
          <PriorityGlyph priority={thread.priority} t={t} />
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted">
          <span className="flex items-center gap-0.5">
            <Bot className="h-3 w-3" />
            {thread.activeSessionCount}/{thread.sessionCount}
          </span>
          <span className="ml-auto truncate">{lastActivity}</span>
        </div>
      </button>
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
  const stopLabel = t("orchestrator.action.stopAgent", {
    defaultValue: "Stop agent",
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
    <div className="rounded-md border border-border/40 bg-bg/40 p-2">
      <div className="flex items-center gap-1.5">
        <SessionGlyph status={session.status} t={t} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-txt">
          {session.label}
        </span>
        {stoppable ? (
          <button
            ref={stopRef}
            type="button"
            disabled={busy}
            onClick={() => onStop(session.sessionId)}
            className="flex items-center gap-0.5 rounded px-1 py-0.5 text-2xs text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
            data-testid="orchestrator-stop-agent"
            aria-label={stopLabel}
            {...stopAgentProps}
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
          {formatTokenCount(session.usageState, session.totalTokens, t, locale)}
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
  "w-full rounded-sm border border-border bg-bg px-2.5 py-1.5 text-xs text-txt outline-none transition-colors placeholder:text-muted focus:border-accent focus:ring-1 focus:ring-accent/30";

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
  const submit = () =>
    onSubmit({
      title: title.trim(),
      goal: goal.trim(),
      priority,
      acceptanceCriteria: criteria
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    });
  const closeLabel = t("orchestrator.action.close", { defaultValue: "Close" });
  const cancelLabel = t("orchestrator.action.cancel", {
    defaultValue: "Cancel",
  });
  const createLabel = t("orchestrator.action.createTask", {
    defaultValue: "Create task",
  });
  const { ref: closeRef, agentProps: closeAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "create-task-close",
      role: "button",
      label: closeLabel,
      group: "orchestrator-create-task",
      description: "Close the create-task dialog",
    });
  const { ref: titleRef, agentProps: titleAgentProps } =
    useAgentElement<HTMLInputElement>({
      id: "create-task-title",
      role: "text-input",
      label: t("orchestrator.create.taskTitle", { defaultValue: "Title" }),
      group: "orchestrator-create-task",
      description: "Task title",
      getValue: () => title,
      onFill: (value) => setTitle(value),
    });
  const { ref: goalRef, agentProps: goalAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "create-task-goal",
      role: "textarea",
      label: t("orchestrator.create.goal", { defaultValue: "Goal" }),
      group: "orchestrator-create-task",
      description: "Task goal inherited by sub-agents",
      getValue: () => goal,
      onFill: (value) => setGoal(value),
    });
  const { ref: priorityRef, agentProps: priorityAgentProps } =
    useAgentElement<HTMLSelectElement>({
      id: "create-task-priority",
      role: "select",
      label: t("orchestrator.create.priority", { defaultValue: "Priority" }),
      group: "orchestrator-create-task",
      description: "Task priority",
      options: ["low", "normal", "high", "urgent"],
      getValue: () => priority,
      onFill: (value) => setPriority(paramPriority(value) ?? "normal"),
    });
  const { ref: criteriaRef, agentProps: criteriaAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "create-task-acceptance",
      role: "textarea",
      label: t("orchestrator.create.acceptance", {
        defaultValue: "Acceptance criteria (one per line)",
      }),
      group: "orchestrator-create-task",
      description: "Acceptance criteria, one per line",
      getValue: () => criteria,
      onFill: (value) => setCriteria(value),
    });
  const { ref: cancelRef, agentProps: cancelAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "create-task-cancel",
      role: "button",
      label: cancelLabel,
      group: "orchestrator-create-task",
      description: "Cancel and close the create-task dialog",
    });
  const { ref: submitRef, agentProps: submitAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "create-task-submit",
      role: "button",
      label: createLabel,
      group: "orchestrator-create-task",
      description: "Create the task with the entered title and goal",
      onActivate: () => {
        if (canSubmit) submit();
      },
    });

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
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted transition-colors hover:bg-bg-hover/60"
            aria-label={closeLabel}
            {...closeAgentProps}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <label>
          <FieldLabel>
            {t("orchestrator.create.taskTitle", { defaultValue: "Title" })}
          </FieldLabel>
          <input
            ref={titleRef}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className={FIELD_CLASS}
            placeholder={t("orchestrator.create.titlePlaceholder", {
              defaultValue: "Short, action-oriented name",
            })}
            data-testid="orchestrator-create-title"
            {...titleAgentProps}
          />
        </label>
        <label>
          <FieldLabel>
            {t("orchestrator.create.goal", { defaultValue: "Goal" })}
          </FieldLabel>
          <textarea
            ref={goalRef}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={4}
            className={`${FIELD_CLASS} resize-none`}
            placeholder={t("orchestrator.create.goalPlaceholder", {
              defaultValue:
                "What must be true when this is done? Sub-agents inherit this goal.",
            })}
            data-testid="orchestrator-create-goal"
            {...goalAgentProps}
          />
        </label>
        <label>
          <FieldLabel>
            {t("orchestrator.create.priority", { defaultValue: "Priority" })}
          </FieldLabel>
          <select
            ref={priorityRef}
            value={priority}
            onChange={(event) =>
              setPriority(event.target.value as TaskPriority)
            }
            className={FIELD_CLASS}
            data-testid="orchestrator-create-priority"
            {...priorityAgentProps}
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
            ref={criteriaRef}
            value={criteria}
            onChange={(event) => setCriteria(event.target.value)}
            rows={3}
            className={`${FIELD_CLASS} resize-none`}
            placeholder={t("orchestrator.create.acceptancePlaceholder", {
              defaultValue: "Tests pass\nNo type errors\nScreenshots verified",
            })}
            data-testid="orchestrator-create-acceptance"
            {...criteriaAgentProps}
          />
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <Button
            ref={cancelRef}
            variant="secondary"
            size="sm"
            onClick={onClose}
            className="h-7 px-2.5 text-xs-tight"
            {...cancelAgentProps}
          >
            {cancelLabel}
          </Button>
          <Button
            ref={submitRef}
            size="sm"
            disabled={!canSubmit}
            onClick={submit}
            className="h-7 px-2.5 text-xs-tight"
            data-testid="orchestrator-create-submit"
            {...submitAgentProps}
          >
            {createLabel}
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
    <div className="mt-1.5 space-y-1.5 rounded-md border border-border/50 bg-bg/40 p-2">
      <input
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
        <input
          ref={frameworkRef}
          value={framework}
          onChange={(event) => setFramework(event.target.value)}
          className={FIELD_CLASS}
          placeholder={fieldLabels.framework}
          aria-label={fieldLabels.framework}
          {...frameworkAgentProps}
        />
        <input
          ref={modelRef}
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className={FIELD_CLASS}
          placeholder={fieldLabels.model}
          aria-label={fieldLabels.model}
          {...modelAgentProps}
        />
      </div>
      <input
        ref={workdirRef}
        value={workdir}
        onChange={(event) => setWorkdir(event.target.value)}
        className={FIELD_CLASS}
        placeholder={fieldLabels.workdir}
        aria-label={fieldLabels.workdir}
        {...workdirAgentProps}
      />
      <input
        ref={repoRef}
        value={repo}
        onChange={(event) => setRepo(event.target.value)}
        className={FIELD_CLASS}
        placeholder={fieldLabels.repo}
        aria-label={fieldLabels.repo}
        {...repoAgentProps}
      />
      <textarea
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
    <button
      ref={ref}
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
      {...agentProps}
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
    useAgentElement<HTMLSelectElement>({
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
            ref={closeRef}
            type="button"
            onClick={onClose}
            className="-mr-1 rounded p-1 text-muted transition-colors hover:bg-bg-hover/60 hover:text-txt"
            aria-label={closeDetailsLabel}
            data-testid="orchestrator-close-inspector"
            {...closeAgentProps}
          >
            <X className="h-4 w-4" />
          </button>
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
        <ControlButton
          agentId="inspector-fork"
          description="Fork this task into a new task"
          icon={<GitFork className="h-3 w-3" />}
          label={t("orchestrator.action.fork", { defaultValue: "Fork" })}
          onClick={onFork}
          disabled={busy}
          testId="orchestrator-fork"
        />
        {archived ? null : (
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
          <select
            ref={priorityRef}
            aria-label={setPriorityLabel}
            value={detail.priority}
            disabled={busy}
            onChange={(event) => {
              const next = paramPriority(event.target.value);
              if (next && next !== detail.priority) onSetPriority(next);
            }}
            className="rounded-md border border-border/50 bg-transparent px-2 py-1 text-2xs text-muted transition-colors hover:bg-bg-hover/60 hover:text-txt disabled:opacity-50"
            data-testid="orchestrator-priority-select"
            {...priorityAgentProps}
          >
            <option value="low">{labelPriority("low", t)}</option>
            <option value="normal">{labelPriority("normal", t)}</option>
            <option value="high">{labelPriority("high", t)}</option>
            <option value="urgent">{labelPriority("urgent", t)}</option>
          </select>
        )}
        <ControlButton
          agentId="inspector-delete"
          description="Delete this task"
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
      <div className="border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            ref={backRef}
            type="button"
            onClick={onBack}
            className="-ml-1 shrink-0 rounded p-1 text-muted transition-colors hover:bg-bg-hover/60 hover:text-txt"
            aria-label={backLabel}
            data-testid="orchestrator-back"
            {...backAgentProps}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          {statusDot}
          {title}
          <button
            ref={detailsRef}
            type="button"
            onClick={onOpenInspector}
            className="shrink-0 rounded-md border border-border/50 p-1 text-muted transition-colors hover:bg-bg-hover/60 hover:text-txt"
            aria-label={detailsLabel}
            title={detailsLabel}
            data-testid="orchestrator-open-inspector"
            {...detailsAgentProps}
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
    // Discard if a newer fetch superseded this one, or if the selection moved on
    // while in flight — otherwise a non-reset poll/refresh could merge one task's
    // transcript into another task's room (cross-task contamination).
    if (token !== detailReqRef.current || id !== selectedIdRef.current) return;
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

  const detailPollMs =
    detail !== null &&
    (detail.activeSessionCount > 0 ||
      detail.status === "active" ||
      detail.status === "validating")
      ? ACTIVE_POLL_INTERVAL_MS
      : POLL_INTERVAL_MS;

  useEffect(() => {
    // Reset transient per-task UI (mobile inspector drawer, add-agent form)
    // and load the room whenever the selection changes, so a freshly opened
    // task starts clean and scrolled to its latest activity.
    setInspectorOpen(false);
    setAddAgentOpen(false);
    stickToBottomRef.current = true;
    if (!selectedId) {
      setDetail(null);
      setMessages([]);
      setEvents([]);
      setMessageCursor(null);
      return;
    }
    void fetchDetail(selectedId, true).catch(() => {});
  }, [selectedId, fetchDetail]);

  useEffect(() => {
    // Reconcile poll — the safety net. The SSE stream below drives near-live
    // updates; this only covers a dropped/absent stream (reconnect fallback).
    if (!selectedId) return;
    const timer = window.setInterval(
      () => void fetchDetail(selectedId, false).catch(() => {}),
      detailPollMs,
    );
    return () => window.clearInterval(timer);
  }, [selectedId, detailPollMs, fetchDetail]);

  // Coalesce a burst of change pings into one tail refetch per ~150ms window,
  // so live token streaming doesn't trigger a fetch storm.
  const refetchTimerRef = useRef<number | null>(null);
  const scheduleRefetch = useCallback(() => {
    if (refetchTimerRef.current != null) return;
    refetchTimerRef.current = window.setTimeout(() => {
      refetchTimerRef.current = null;
      const current = selectedIdRef.current;
      if (current) void fetchDetail(current, false).catch(() => {});
    }, 150);
  }, [fetchDetail]);

  useEffect(() => {
    // Live push: subscribe to the task's SSE stream; each "change" ping
    // schedules a debounced tail refetch, so messages/tool-calls/status appear
    // ~instantly instead of on the poll boundary.
    if (!selectedId) return;
    const unsubscribe = client.streamOrchestratorTask(
      selectedId,
      scheduleRefetch,
    );
    return () => {
      unsubscribe();
      if (refetchTimerRef.current != null) {
        window.clearTimeout(refetchTimerRef.current);
        refetchTimerRef.current = null;
      }
    };
  }, [selectedId, scheduleRefetch]);

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
            defaultValue:
              "Message was recorded, but no active agent accepted it.",
          }),
        );
      }
      setComposer("");
    });
  }, [composer, runMutation, t]);

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
    createOpen,
    addAgentOpen,
    inspectorOpen,
    stop: handleStopActive,
  });
  escStateRef.current = {
    createOpen,
    addAgentOpen,
    inspectorOpen,
    stop: handleStopActive,
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const s = escStateRef.current;
      if (s.createOpen) {
        setCreateOpen(false);
        return;
      }
      if (s.addAgentOpen) {
        setAddAgentOpen(false);
        return;
      }
      if (s.inspectorOpen) {
        setInspectorOpen(false);
        return;
      }
      s.stop();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

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
  const composerLabel = t("orchestrator.composerPlaceholder", {
    defaultValue: "Message the orchestrator…",
  });
  const sendLabel = t("orchestrator.action.send", { defaultValue: "Send" });
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
    useAgentElement<HTMLInputElement>({
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
      description: "Load older messages in the task timeline",
    });
  const { ref: stopActiveRef, agentProps: stopActiveAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "timeline-stop-active",
      role: "button",
      label: stopLabel,
      group: "orchestrator-timeline",
      description: "Stop the running sub-agents on this task",
    });
  const { ref: composerRef, agentProps: composerAgentProps } =
    useAgentElement<HTMLTextAreaElement>({
      id: "timeline-composer",
      role: "textarea",
      label: composerLabel,
      group: "orchestrator-timeline",
      description: "Message to send to the orchestrator for this task",
      getValue: () => composer,
      onFill: (value) => setComposer(value),
    });
  const { ref: sendRef, agentProps: sendAgentProps } =
    useAgentElement<HTMLButtonElement>({
      id: "timeline-send",
      role: "button",
      label: sendLabel,
      group: "orchestrator-timeline",
      description: "Send the composed message to the orchestrator",
      onActivate: () => {
        if (!mutating && composer.trim() !== "") handleSend();
      },
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
              ref={searchRef}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchLabel}
              aria-label={searchLabel}
              className={FIELD_CLASS}
              data-testid="orchestrator-search"
              {...searchAgentProps}
            />
            <FilterSelect
              status={status}
              active={statusFilter}
              onSelect={setStatusFilter}
              t={t}
            />
            <label className="flex items-center gap-1.5 text-2xs text-muted">
              <input
                ref={showArchivedRef}
                type="checkbox"
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
                className="h-3 w-3"
                style={{ accentColor: "var(--accent)" }}
                aria-label={showArchivedLabel}
                data-testid="orchestrator-show-archived"
                {...showArchivedAgentProps}
              />
              {showArchivedLabel}
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
                <div className="flex flex-col items-center gap-2 px-3 py-10 text-center">
                  <Activity className="h-7 w-7 text-muted/50" />
                  <p className="text-xs text-muted">
                    {t("orchestrator.empty.title", {
                      defaultValue: "No tasks yet",
                    })}
                  </p>
                  <Button
                    size="sm"
                    onClick={() => setCreateOpen(true)}
                    className="h-7 gap-1.5 px-2.5 text-xs-tight font-semibold"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {t("orchestrator.action.newTask", {
                      defaultValue: "New task",
                    })}
                  </Button>
                </div>
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
                ref={listRef}
                onScroll={handleListScroll}
                className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
                data-testid="orchestrator-message-list"
              >
                {messageCursor ? (
                  <div className="flex justify-center">
                    <button
                      ref={loadOlderRef}
                      type="button"
                      onClick={() => void loadOlderMessages()}
                      className="flex items-center gap-1 rounded-full border border-border/50 px-2.5 py-0.5 text-2xs text-muted transition-colors hover:bg-bg-hover/50"
                      data-testid="orchestrator-load-older"
                      aria-label={loadOlderLabel}
                      {...loadOlderAgentProps}
                    >
                      <ArrowDownToLine className="h-3 w-3" />
                      {loadOlderLabel}
                    </button>
                  </div>
                ) : null}
                {conversation.length === 0 ? (
                  <p className="p-4 text-center text-xs text-muted">
                    {t("orchestrator.noMessages", {
                      defaultValue: "No messages yet.",
                    })}
                  </p>
                ) : (
                  conversation.map((block) => (
                    <ConversationBlockView
                      key={block.key}
                      block={block}
                      locale={locale}
                    />
                  ))
                )}
              </div>
              {detail.activeSessionCount > 0 ? (
                <div
                  className="flex items-center justify-between gap-2 border-t border-border/50 bg-warn/5 px-3 py-1.5"
                  data-testid="orchestrator-running-bar"
                >
                  <span className="flex items-center gap-1.5 text-2xs font-medium text-warn">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-warn" />
                    {t("orchestrator.agentsWorking", {
                      defaultValue: "Agent working…",
                    })}
                  </span>
                  <button
                    ref={stopActiveRef}
                    type="button"
                    onClick={handleStopActive}
                    disabled={mutating}
                    className="flex items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-2xs text-txt transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                    data-testid="orchestrator-stop-active"
                    aria-label={stopLabel}
                    {...stopActiveAgentProps}
                  >
                    <CircleStop className="h-3 w-3" />
                    {stopLabel}
                    <kbd className="ml-0.5 rounded bg-bg-hover/60 px-1 text-[0.9em] text-muted">
                      Esc
                    </kbd>
                  </button>
                </div>
              ) : null}
              <div className="border-t border-border/50 bg-bg px-4 py-3">
                <div className="flex items-end gap-2">
                  <textarea
                    ref={composerRef}
                    value={composer}
                    onChange={(event) => setComposer(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        handleSend();
                      }
                    }}
                    rows={1}
                    placeholder={composerLabel}
                    aria-label={composerLabel}
                    className={`${FIELD_CLASS} max-h-32 resize-none`}
                    data-testid="orchestrator-composer"
                    {...composerAgentProps}
                  />
                  <Button
                    ref={sendRef}
                    size="sm"
                    disabled={mutating || composer.trim() === ""}
                    onClick={handleSend}
                    className="h-8 w-8 shrink-0 p-0"
                    aria-label={sendLabel}
                    title={sendLabel}
                    data-testid="orchestrator-send"
                    {...sendAgentProps}
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
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-sm bg-accent-subtle">
                <Layers className="h-6 w-6 text-accent" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-semibold text-txt-strong">
                  {t("orchestrator.noSelection.title", {
                    defaultValue: "No task open",
                  })}
                </p>
                <p className="max-w-xs text-xs leading-relaxed text-muted">
                  {t("orchestrator.noSelection.hint", {
                    defaultValue:
                      "Pick a task from the list to inspect its room — or start a new coding task.",
                  })}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => setCreateOpen(true)}
                className="h-8 gap-1.5 px-3 text-xs-tight font-semibold"
              >
                <Plus className="h-3.5 w-3.5" />
                {t("orchestrator.action.newTask", { defaultValue: "New task" })}
              </Button>
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
            onDelete={() => {
              const confirmed =
                typeof window === "undefined" ||
                window.confirm(
                  t("orchestrator.confirmDelete", {
                    defaultValue:
                      "Delete this task and its transcript? This can't be undone.",
                  }),
                );
              if (!confirmed) return;
              runMutation(async () => {
                await client.deleteOrchestratorTask(detail.id);
                setSelectedId(null);
              });
            }}
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
