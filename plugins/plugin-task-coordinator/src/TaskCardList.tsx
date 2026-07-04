// Shared visual task-card language for the /orchestrator and /task-coordinator
// single-pane landings. Both views render the same card medallion + chips so the
// two surfaces read as one product. Pure presentation — no data fetching.
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Button } from "@elizaos/ui/components/ui/button";
import { Input } from "@elizaos/ui/components/ui/input";
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
  Search,
  UserRound,
} from "lucide-react";
import type { ReactNode, Ref } from "react";

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
  /** Status-dot color for the trailing chip. */
  dot: string;
  pulse: boolean;
}

// Single source of per-status visuals. Use color and iconography instead of
// boxed badges so the task lists stay dense.
const STATUS_VISUAL: Record<TaskCardStatus, StatusVisual> = {
  open: {
    icon: Circle,
    fg: "text-accent",
    dot: "bg-accent",
    pulse: false,
  },
  active: {
    icon: CirclePlay,
    fg: "text-ok",
    dot: "bg-ok",
    pulse: true,
  },
  validating: {
    icon: CircleDashed,
    fg: "text-accent",
    dot: "bg-accent",
    pulse: true,
  },
  waiting_on_user: {
    icon: UserRound,
    fg: "text-warn",
    dot: "bg-warn",
    pulse: false,
  },
  blocked: {
    icon: OctagonX,
    fg: "text-warn",
    dot: "bg-warn",
    pulse: false,
  },
  interrupted: {
    icon: CircleAlert,
    fg: "text-warn",
    dot: "bg-warn",
    pulse: false,
  },
  done: {
    icon: CircleCheck,
    fg: "text-ok",
    dot: "bg-ok",
    pulse: false,
  },
  failed: {
    icon: CircleX,
    fg: "text-danger",
    dot: "bg-danger",
    pulse: false,
  },
  archived: {
    icon: Archive,
    fg: "text-muted",
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

/** Status icon — the row's primary visual anchor. */
export function TaskStatusMedallion({
  status,
  size = "h-8 w-8",
  iconSize = "h-4 w-4",
}: {
  status: string;
  size?: string;
  iconSize?: string;
}) {
  const visual = statusVisual(status);
  const Icon = visual.icon;
  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center ${size}`}
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
      className={`inline-flex items-center gap-1.5 text-2xs font-medium ${visual.fg}`}
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
      className={`inline-flex items-center gap-1 text-2xs tabular-nums ${
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

/** Search field shared so both landings read identically. */
export function TaskSearchInput({
  value,
  onChange,
  placeholder,
  inputRef,
  testId,
  className,
  agentProps,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  inputRef?: Ref<HTMLInputElement>;
  testId?: string;
  className?: string;
  agentProps?: Record<string, unknown>;
}) {
  return (
    <div
      className={`relative flex h-9 items-center border-border/35 border-b transition-colors focus-within:border-accent/60 ${className ?? "flex-1"}`}
    >
      <Search
        className="pointer-events-none absolute left-1 h-3.5 w-3.5 text-muted"
        aria-hidden
      />
      <Input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        data-testid={testId}
        className="h-full w-full bg-transparent pl-7 pr-1 text-sm text-txt outline-none placeholder:text-muted"
        {...agentProps}
      />
    </div>
  );
}

/** A quiet oversized watermark glyph pinned bottom-right, used to ground the
 * empty void beneath a short task list. Decorative only, very low opacity. */
export function SparseWatermark({ icon }: { icon: LucideIcon }) {
  const Icon = icon;
  return (
    <div
      className="pointer-events-none absolute bottom-6 right-4 select-none"
      aria-hidden
    >
      <Icon className="h-44 w-44 text-accent opacity-[0.05]" strokeWidth={1} />
    </div>
  );
}

/** Shared task row. Clicking opens the view's full-pane detail. */
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
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `task-card-${id}`,
    role: "list-item",
    label: title,
    group: "task-cards",
    description: `Open the "${title}" task`,
  });
  return (
    <Button
      unstyled
      ref={ref}
      type="button"
      onClick={() => onOpen(id)}
      data-testid="task-card"
      className="group relative flex w-full items-start gap-2 px-1 py-2 text-left transition-colors hover:bg-bg-hover/30"
      {...agentProps}
    >
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
    </Button>
  );
}

/** Compact page header shared across both views. */
export function TaskListHeader({
  icon,
  title,
  counts,
  action,
  leading,
}: {
  icon: ReactNode;
  title: string;
  counts: ReactNode;
  action?: ReactNode;
  /** Optional control rendered flush-left before the icon — the full-page
   *  Tasks view passes the shared back-to-launcher button here so its header
   *  chrome matches the other top-level views. */
  leading?: ReactNode;
}) {
  return (
    <header className="flex items-center gap-2 px-1 py-0.5">
      {leading ? <span className="shrink-0">{leading}</span> : null}
      <span className="shrink-0 text-accent">{icon}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <h1 className="truncate text-base font-semibold text-txt-strong">
          {title}
        </h1>
        <div className="flex flex-wrap items-center gap-2">{counts}</div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}

/** Labeled count text for the header (e.g. "3 active"). */
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
      ? "text-ok"
      : tone === "accent"
        ? "text-accent"
        : tone === "warn"
          ? "text-warn"
          : "text-muted";
  return (
    <span className={`inline-flex items-baseline gap-1 text-2xs ${toneClass}`}>
      <span className="font-semibold tabular-nums">{value}</span>
      <span className="opacity-70">{label}</span>
    </span>
  );
}

/** Quiet empty state: one glyph + a short title, lots of open space. The longer
 * hint stays for screen readers only — on screen, the icon carries the meaning. */
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
      className="flex flex-col items-center gap-3 py-16 text-center"
      data-testid="task-empty-state"
    >
      <CircleDashed
        className="h-10 w-10 text-accent/40"
        strokeWidth={1.5}
        aria-hidden
      />
      <p className="text-sm font-medium text-muted">{title}</p>
      <p className="max-w-xs text-xs text-muted/80">{hint}</p>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

/** Back-to-list control used to leave a full-pane detail. */
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
    <Button
      unstyled
      ref={ref}
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="inline-flex items-center gap-1.5 py-1 text-xs font-medium text-muted transition-colors hover:text-txt"
      {...agentProps}
    >
      <span aria-hidden>←</span>
      {label}
    </Button>
  );
}
