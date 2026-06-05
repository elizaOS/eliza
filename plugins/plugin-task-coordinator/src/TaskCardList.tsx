// Shared visual task-card language for the /orchestrator and /task-coordinator
// single-pane landings. Both views render the same card medallion + chips so the
// two surfaces read as one product. Pure presentation — no data fetching.
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  Archive,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CirclePlay,
  CircleX,
  GitBranch,
  type LucideIcon,
  OctagonX,
  Sparkles,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";

export type TaskCardStatus =
  | "open"
  | "active"
  | "waiting_on_user"
  | "blocked"
  | "validating"
  | "done"
  | "failed"
  | "archived"
  | "interrupted";

type Translate = (key: string, vars?: Record<string, unknown>) => string;

interface StatusVisual {
  icon: LucideIcon;
  /** Foreground icon tone. */
  fg: string;
  /** Medallion background tint. */
  tint: string;
  /** Status-dot color for the trailing chip. */
  dot: string;
  pulse: boolean;
}

// Single source of per-status visuals. Tints lean on theme tokens only — orange
// accent for in-flight, ok/warn/danger for terminal/attention, muted for idle.
const STATUS_VISUAL: Record<TaskCardStatus, StatusVisual> = {
  open: {
    icon: Circle,
    fg: "text-muted",
    tint: "bg-surface",
    dot: "bg-muted",
    pulse: false,
  },
  active: {
    icon: CirclePlay,
    fg: "text-ok",
    tint: "bg-ok/12",
    dot: "bg-ok",
    pulse: true,
  },
  validating: {
    icon: CircleDashed,
    fg: "text-accent",
    tint: "bg-accent-subtle",
    dot: "bg-accent",
    pulse: true,
  },
  waiting_on_user: {
    icon: UserRound,
    fg: "text-warn",
    tint: "bg-warn/12",
    dot: "bg-warn",
    pulse: false,
  },
  blocked: {
    icon: OctagonX,
    fg: "text-warn",
    tint: "bg-warn/12",
    dot: "bg-warn",
    pulse: false,
  },
  interrupted: {
    icon: CircleAlert,
    fg: "text-warn",
    tint: "bg-warn/12",
    dot: "bg-warn",
    pulse: false,
  },
  done: {
    icon: CircleCheck,
    fg: "text-ok",
    tint: "bg-ok/12",
    dot: "bg-ok",
    pulse: false,
  },
  failed: {
    icon: CircleX,
    fg: "text-danger",
    tint: "bg-danger/12",
    dot: "bg-danger",
    pulse: false,
  },
  archived: {
    icon: Archive,
    fg: "text-muted",
    tint: "bg-surface",
    dot: "bg-muted",
    pulse: false,
  },
};

function statusVisual(status: string): StatusVisual {
  return STATUS_VISUAL[status as TaskCardStatus] ?? STATUS_VISUAL.open;
}

export function statusLabel(status: string, t: Translate): string {
  return t(`orchestrator.status.${status}`, {
    defaultValue: status.replace(/_/g, " "),
  });
}

/** Round status medallion — the card's primary visual anchor. */
export function TaskStatusMedallion({
  status,
  size = "h-11 w-11",
  iconSize = "h-5 w-5",
}: {
  status: string;
  size?: string;
  iconSize?: string;
}) {
  const visual = statusVisual(status);
  const Icon = visual.icon;
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center rounded-2xl ${size} ${visual.tint}`}
    >
      <Icon
        className={`${iconSize} ${visual.fg}${visual.pulse ? " animate-pulse" : ""}`}
        aria-hidden
      />
    </span>
  );
}

/** Status chip with a colored leading dot — the only textual status on a card. */
export function TaskStatusChip({
  status,
  t,
}: {
  status: string;
  t: Translate;
}) {
  const visual = statusVisual(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-semibold ${visual.tint} ${visual.fg}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full ${visual.dot}${visual.pulse ? " animate-pulse" : ""}`}
      />
      {statusLabel(status, t)}
    </span>
  );
}

/** A small icon + value chip used for sessions / decisions / age metadata. */
export function TaskMetaChip({
  icon,
  children,
  tone = "muted",
}: {
  icon: ReactNode;
  children: ReactNode;
  tone?: "muted" | "accent";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md bg-surface px-1.5 py-0.5 text-2xs tabular-nums ${
        tone === "accent" ? "text-accent" : "text-muted"
      }`}
    >
      <span className="inline-flex h-3 w-3 items-center justify-center">
        {icon}
      </span>
      {children}
    </span>
  );
}

/** The shared visual task card. Clicking opens the view's full-pane detail. */
export function TaskCard({
  id,
  title,
  subtitle,
  status,
  chips,
  forked,
  onOpen,
  t,
}: {
  id: string;
  title: string;
  subtitle?: string | null;
  status: string;
  chips: ReactNode;
  forked?: boolean;
  onOpen: (id: string) => void;
  t: Translate;
}) {
  const visual = statusVisual(status);
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `task-card-${id}`,
    role: "list-item",
    label: title,
    group: "task-cards",
    description: `Open the "${title}" task`,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(id)}
      data-testid="task-card"
      className="group relative flex w-full items-start gap-3 overflow-hidden rounded-2xl border border-border/50 bg-bg-accent/30 p-3 text-left transition-colors hover:border-accent/40 hover:bg-bg-hover/40"
      {...agentProps}
    >
      <span
        className={`absolute inset-y-0 left-0 w-1 ${visual.dot} opacity-70`}
        aria-hidden
      />
      <TaskStatusMedallion status={status} />
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-txt-strong">
            {title}
          </span>
          {forked ? (
            <GitBranch
              className="h-3.5 w-3.5 shrink-0 text-muted"
              aria-hidden
            />
          ) : null}
          <TaskStatusChip status={status} t={t} />
        </span>
        {subtitle ? (
          <span className="line-clamp-1 text-xs text-muted">{subtitle}</span>
        ) : null}
        <span className="flex flex-wrap items-center gap-1.5">{chips}</span>
      </span>
    </button>
  );
}

/** Page header: medallion + title + count chips. Shared across both views. */
export function TaskListHeader({
  icon,
  title,
  counts,
  action,
}: {
  icon: ReactNode;
  title: string;
  counts: ReactNode;
  action?: ReactNode;
}) {
  return (
    <header className="flex items-center gap-3 px-1 py-1">
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-accent-subtle text-accent">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h1 className="truncate text-lg font-semibold tracking-tight text-txt-strong">
          {title}
        </h1>
        <div className="flex flex-wrap items-center gap-1.5">{counts}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

/** A labeled count pill for the header (e.g. "3 active"). */
export function TaskCountChip({
  value,
  label,
  tone = "neutral",
}: {
  value: number | string;
  label: string;
  tone?: "neutral" | "active" | "accent" | "warn";
}) {
  const toneClass =
    tone === "active"
      ? "bg-ok/12 text-ok"
      : tone === "accent"
        ? "bg-accent-subtle text-accent"
        : tone === "warn"
          ? "bg-warn/12 text-warn"
          : "bg-surface text-muted";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold ${toneClass}`}
    >
      <span className="tabular-nums">{value}</span>
      <span className="font-medium uppercase tracking-[0.06em] opacity-80">
        {label}
      </span>
    </span>
  );
}

/** Generative SVG motif for the empty state — token-gradient orbiting rings. */
function EmptyMotif() {
  return (
    <svg
      width="148"
      height="148"
      viewBox="0 0 148 148"
      fill="none"
      role="img"
      aria-label="Decorative orbiting rings"
      className="text-accent"
    >
      <title>Decorative orbiting rings</title>
      <defs>
        <linearGradient id="tc-ring" x1="0" y1="0" x2="148" y2="148">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.9" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.15" />
        </linearGradient>
        <radialGradient id="tc-core" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="74" cy="74" r="60" fill="url(#tc-core)" />
      <circle
        cx="74"
        cy="74"
        r="58"
        stroke="url(#tc-ring)"
        strokeWidth="1.5"
        strokeDasharray="4 7"
        opacity="0.7"
      />
      <circle
        cx="74"
        cy="74"
        r="42"
        stroke="url(#tc-ring)"
        strokeWidth="1.5"
        opacity="0.55"
      />
      <circle cx="74" cy="16" r="3.5" fill="var(--accent)" opacity="0.9" />
      <circle cx="132" cy="74" r="2.5" fill="var(--accent)" opacity="0.6" />
      <circle cx="74" cy="116" r="2.5" fill="var(--accent)" opacity="0.5" />
      <circle cx="32" cy="74" r="2.5" fill="var(--accent)" opacity="0.6" />
    </svg>
  );
}

/** Rich visual empty state shown when there are no tasks. */
export function TaskEmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint: string;
  action?: ReactNode;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border/50 bg-bg-accent/20 px-6 py-12 text-center"
      data-testid="task-empty-state"
    >
      <div className="relative flex items-center justify-center">
        <EmptyMotif />
        <Sparkles className="absolute h-7 w-7 text-accent" aria-hidden />
      </div>
      <div className="space-y-1.5">
        <p className="text-base font-semibold text-txt-strong">{title}</p>
        <p className="mx-auto max-w-sm text-sm leading-relaxed text-muted">
          {hint}
        </p>
      </div>
      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}

/** A back-to-list chip used to leave a full-pane detail. */
export function BackChip({
  label,
  onClick,
  testId,
}: {
  label: string;
  onClick: () => void;
  testId?: string;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: "task-back-chip",
    role: "button",
    label,
    group: "task-detail",
    description: "Return to the task list",
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="inline-flex items-center gap-1.5 rounded-full border border-border/50 bg-bg-accent/40 px-3 py-1 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:text-txt"
      {...agentProps}
    >
      <span aria-hidden>←</span>
      {label}
    </button>
  );
}
