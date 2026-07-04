/**
 * Pure presentational vocabulary for the orchestrator workbench (#9960):
 * status/session/verification/plan-step icon + tone maps, the label helpers,
 * and the small glyph components. Stateless, runtime-free, and shared across the
 * header, task cards, inspector, and timeline of OrchestratorWorkbench.tsx, so
 * they live here on their own. No data-layer, no `client`, no hooks.
 */

import type {
  CodingAgentTaskArtifactRecord,
  CodingAgentTaskMessageRecord,
  CodingAgentTaskThread,
} from "@elizaos/ui";
import {
  Archive,
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
  type LucideIcon,
  OctagonX,
  UserRound,
} from "lucide-react";
import type { TaskPriority } from "./orchestrator-params";

export type Translate = (key: string, vars?: Record<string, unknown>) => string;
export type TaskStatus = CodingAgentTaskThread["status"];
export type StatusFilter = "all" | TaskStatus;

export const fallbackTranslate: Translate = (key, vars) =>
  String(vars?.defaultValue ?? key);

export const STATUS_ICON: Record<TaskStatus, LucideIcon> = {
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

export const STATUS_TONE: Record<TaskStatus, string> = {
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

export const STATUS_PULSE: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "active",
  "validating",
]);

/** Terminal task statuses — the task is settled and no longer mutable
 * through the Edit-group actions (fork, restart, add agent, edit plan)
 * or the priority dropdown. Reopen (when archived) and Delete remain the
 * only meaningful affordances. Mirrors the design doc's
 * {done, failed, archived} set; the `CodingAgentTaskThread["status"]`
 * union has no `"closed"` member. */
export const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> =
  new Set<TaskStatus>(["done", "failed", "archived"]);

export const PRIORITY_ICON: Record<TaskPriority, LucideIcon | null> = {
  low: ChevronDown,
  normal: null,
  high: ChevronUp,
  urgent: ChevronsUp,
};

export const SESSION_ICON: Record<string, LucideIcon> = {
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

export const SESSION_TONE: Record<string, string> = {
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

export const SESSION_PULSE: ReadonlySet<string> = new Set([
  "active",
  "running",
  "tool_running",
]);

export const VERIFICATION_ICON: Record<
  CodingAgentTaskArtifactRecord["verificationStatus"],
  LucideIcon
> = {
  passed: CircleCheck,
  failed: CircleX,
  pending: CircleDashed,
  unknown: Circle,
};

export const VERIFICATION_TONE: Record<
  CodingAgentTaskArtifactRecord["verificationStatus"],
  string
> = {
  passed: "text-ok",
  failed: "text-danger",
  pending: "text-warn",
  unknown: "text-muted",
};

export const PLAN_STEP_ICON: Record<string, LucideIcon> = {
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

export const PLAN_STEP_TONE: Record<string, string> = {
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

export const FILTER_OPTIONS: StatusFilter[] = [
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

export const STATUS_LABEL_KEY: Record<TaskStatus, string> = {
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

export function labelStatus(status: TaskStatus, t: Translate): string {
  return t(STATUS_LABEL_KEY[status], {
    defaultValue: status.replace(/_/g, " "),
  });
}

export function labelPriority(priority: TaskPriority, t: Translate): string {
  return t(`orchestrator.priority.${priority}`, { defaultValue: priority });
}

/** Sub-agent status labels reuse task-status keys where they overlap and fall
 * back to the raw token otherwise (sessions carry framework-specific states). */
export function labelSessionStatus(status: string, t: Translate): string {
  return t(`orchestrator.sessionStatus.${status}`, {
    defaultValue: status.replace(/_/g, " "),
  });
}

export function StatusGlyph({
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

export function SessionGlyph({
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

export function VerificationGlyph({
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

export function PlanStepGlyph({ status, t }: { status: string; t: Translate }) {
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

export const SENDER_LABEL_KEY: Record<
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

export function labelSender(
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
export function resolveSenderName(
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
