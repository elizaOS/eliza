import { useCalendarWeek } from "@elizaos/plugin-calendar/ui";
import type {
  LifeOpsActiveReminderView,
  LifeOpsCalendarEvent,
  LifeOpsCapabilitiesStatus,
  LifeOpsGoogleCapability,
  LifeOpsGoogleConnectorStatus,
  LifeOpsInboxChannel,
  LifeOpsInboxMessage,
  LifeOpsOverview,
  LifeOpsScheduleInsight,
  LifeOpsXConnectorStatus,
} from "@elizaos/shared";
import { client, useApp } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  ArrowRight,
  AtSign,
  CalendarDays,
  Flame,
  Loader2,
  Mail,
  MessageCircle,
  MessageSquare,
  MessageSquareText,
  Mic2,
  Phone,
  RefreshCw,
  Send,
  Share2,
  Shield,
  Smartphone,
  Sparkles,
  Target,
  TriangleAlert,
} from "lucide-react";
import {
  type ComponentProps,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { LifeOpsSocialHabitSummary } from "../api/client-lifeops.js";
import { useGoogleLifeOpsConnector } from "../hooks/useGoogleLifeOpsConnector.js";
import { useInbox } from "../hooks/useInbox.js";
import { useLifeOpsCapabilitiesStatus } from "../hooks/useLifeOpsCapabilitiesStatus.js";
import type { LifeOpsSection } from "../hooks/useLifeOpsSection.js";
import { useLifeOpsXConnector } from "../hooks/useLifeOpsXConnector.js";
import { BrowserBridgeStatusChip } from "./BrowserBridgeStatusChip.js";
import {
  ASSISTANT_INTENTS,
  LIFEOPS_VOICE_COMMAND_PROMPT,
} from "./LifeOpsAssistantSection.js";
import { useLifeOpsChatLauncher } from "./LifeOpsChatAdapter.helpers.js";
import {
  LIFEOPS_MAIL_CHANNELS,
  LIFEOPS_MESSAGE_CHANNELS,
} from "./LifeOpsInboxSection.js";
import { useLifeOpsSelection } from "./LifeOpsSelectionContext.helpers.js";
import { MissingSourceCard } from "./MissingSourceCard.js";

interface LifeOpsOverviewSectionProps {
  onNavigate: (section: LifeOpsSection) => void;
}

type ReminderUrgency = "overdue" | "soon" | "today" | "later";

type TimelineEntry =
  | {
      id: string;
      kind: "event";
      sortAt: number;
      event: LifeOpsCalendarEvent;
    }
  | {
      id: string;
      kind: "reminder";
      sortAt: number;
      reminder: LifeOpsActiveReminderView;
    };

const URGENCY_STYLES: Record<ReminderUrgency, { dot: string; text: string }> = {
  overdue: {
    dot: "bg-rose-500",
    text: "text-rose-300",
  },
  soon: {
    dot: "bg-amber-400",
    text: "text-amber-300",
  },
  today: {
    dot: "bg-blue-400",
    text: "text-blue-300",
  },
  later: {
    dot: "bg-emerald-400",
    text: "text-emerald-300",
  },
};

const CHANNEL_STYLES: Record<
  LifeOpsInboxChannel,
  { label: string; icon: ReactNode; text: string; bg: string }
> = {
  gmail: {
    label: "Gmail",
    icon: <AtSign className="h-3.5 w-3.5" aria-hidden />,
    text: "text-rose-300",
    bg: "bg-rose-500/12",
  },
  discord: {
    label: "Discord",
    icon: <MessageCircle className="h-3.5 w-3.5" aria-hidden />,
    text: "text-indigo-300",
    bg: "bg-indigo-500/14",
  },
  telegram: {
    label: "Telegram",
    icon: <Send className="h-3.5 w-3.5" aria-hidden />,
    text: "text-sky-300",
    bg: "bg-sky-500/14",
  },
  signal: {
    label: "Signal",
    icon: <Shield className="h-3.5 w-3.5" aria-hidden />,
    text: "text-blue-300",
    bg: "bg-blue-500/14",
  },
  imessage: {
    label: "iMessage",
    icon: <MessageSquare className="h-3.5 w-3.5" aria-hidden />,
    text: "text-emerald-300",
    bg: "bg-emerald-500/14",
  },
  whatsapp: {
    label: "WhatsApp",
    icon: <Smartphone className="h-3.5 w-3.5" aria-hidden />,
    text: "text-lime-300",
    bg: "bg-lime-500/14",
  },
  sms: {
    label: "SMS",
    icon: <Phone className="h-3.5 w-3.5" aria-hidden />,
    text: "text-amber-300",
    bg: "bg-amber-500/14",
  },
  x_dm: {
    label: "X DM",
    icon: <AtSign className="h-3.5 w-3.5" aria-hidden />,
    text: "text-zinc-200",
    bg: "bg-zinc-500/14",
  },
};

const CHANNEL_ORDER: LifeOpsInboxChannel[] = [
  "gmail",
  "imessage",
  "sms",
  "discord",
  "telegram",
  "signal",
  "whatsapp",
  "x_dm",
];

function useGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "Still up";
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  if (hour < 22) return "Evening";
  return "Wind-down";
}

function formatFullDate(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(date);
}

function formatClockTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function formatRelative(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  const diffMs = parsed - Date.now();
  const diffMin = Math.round(diffMs / 60_000);
  if (Math.abs(diffMin) < 1) return "now";
  if (diffMin > 0) {
    if (diffMin < 60) return `in ${diffMin}m`;
    const hrs = Math.round(diffMin / 60);
    if (hrs < 24) return `in ${hrs}h`;
    return `in ${Math.round(hrs / 24)}d`;
  }
  const ago = Math.abs(diffMin);
  if (ago < 60) return `${ago}m ago`;
  const agoH = Math.round(ago / 60);
  if (agoH < 24) return `${agoH}h ago`;
  return `${Math.round(agoH / 24)}d ago`;
}

function formatDurationMinutes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "";
  }
  const total = Math.round(value);
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function formatDurationSeconds(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return "";
  }
  return formatDurationMinutes(value / 60);
}

function humanize(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
}

function startOfLocalDayIso(date = new Date()): string {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start.toISOString();
}

function classifyReminder(iso: string): ReminderUrgency {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return "later";
  const diffMin = Math.round((parsed - Date.now()) / 60_000);
  if (diffMin < 0) return "overdue";
  if (diffMin < 60) return "soon";
  if (diffMin < 60 * 24) return "today";
  return "later";
}

function buildHeadline(args: {
  nextEvent: LifeOpsCalendarEvent | null;
  hasOverdue: boolean;
  hasUnread: boolean;
  hasAnyOverviewAccess: boolean;
}) {
  const { nextEvent, hasOverdue, hasUnread, hasAnyOverviewAccess } = args;
  if (!hasAnyOverviewAccess) {
    return "LifeOps is waiting on access.";
  }
  if (hasOverdue) {
    return "A reminder needs a decision.";
  }
  if (nextEvent) {
    return `${nextEvent.title} at ${formatClockTime(nextEvent.startAt)}.`;
  }
  if (hasUnread) {
    return "Messages need attention.";
  }
  return "The day is open.";
}

function DashboardPanel({
  title,
  icon,
  action,
  className = "",
  children,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={`min-w-0 overflow-hidden rounded-lg border border-border/16 bg-card/12 ${className}`}
    >
      <div className="flex items-center justify-between gap-3 border-b border-border/12 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <h2
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg/30 text-muted"
            title={title}
          >
            <span className="sr-only">{title}</span>
            {icon}
          </h2>
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function overviewSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "action"
  );
}

function IconAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `overview-action-${overviewSlug(label)}`,
    role: "button",
    label,
    group: "lifeops-overview",
    description: label,
  });
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg/40 hover:text-txt"
      onClick={onClick}
      {...agentProps}
    >
      {icon}
    </button>
  );
}

function OverviewNavButton({
  agentId,
  label,
  description,
  children,
  ...buttonProps
}: {
  agentId: string;
  label: string;
  description: string;
  children: ReactNode;
} & ComponentProps<"button">) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: agentId,
    role: "button",
    label,
    group: "lifeops-overview",
    description,
  });
  return (
    <button ref={ref} type="button" {...buttonProps} {...agentProps}>
      {children}
    </button>
  );
}

type OverviewAssistantCommand = {
  id: string;
  label: string;
  icon: ReactNode;
  prompt?: string;
  select?: boolean;
};

function assistantPrompt(intentId: string): string {
  return (
    ASSISTANT_INTENTS.find((intent) => intent.id === intentId)?.prompt ??
    ASSISTANT_INTENTS[0]?.prompt ??
    "Give me a LifeOps command brief."
  );
}

const OVERVIEW_ASSISTANT_COMMANDS: OverviewAssistantCommand[] = [
  {
    id: "ask",
    label: "Ask LifeOps",
    icon: <MessageSquareText className="h-4 w-4" aria-hidden />,
    prompt: assistantPrompt("command-brief"),
    select: true,
  },
  {
    id: "voice",
    label: "Voice command",
    icon: <Mic2 className="h-4 w-4" aria-hidden />,
    prompt: LIFEOPS_VOICE_COMMAND_PROMPT,
    select: false,
  },
  {
    id: "triage",
    label: "Triage",
    icon: <Flame className="h-4 w-4" aria-hidden />,
    prompt: assistantPrompt("inbox-decisions"),
    select: true,
  },
  {
    id: "brief",
    label: "Brief",
    icon: <Sparkles className="h-4 w-4" aria-hidden />,
    prompt: assistantPrompt("command-brief"),
    select: true,
  },
];

function OverviewAssistantDockButton({
  command,
  onLaunch,
}: {
  command: OverviewAssistantCommand;
  onLaunch: (command: OverviewAssistantCommand) => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `overview-assistant-${command.id}`,
    role: "button",
    label: command.label,
    group: "lifeops-overview-assistant",
    description: `Open ${command.label} in LifeOps chat`,
  });
  return (
    <button
      ref={ref}
      type="button"
      aria-label={command.label}
      title={command.label}
      data-testid="lifeops-overview-assistant-command"
      data-command-id={command.id}
      className="inline-flex h-9 min-w-9 items-center justify-center gap-1.5 rounded-lg border border-border/16 bg-bg/35 px-2 text-xs font-semibold text-muted transition-colors hover:border-accent/30 hover:bg-bg-muted/45 hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      onClick={() => onLaunch(command)}
      {...agentProps}
    >
      {command.icon}
      {command.id === "ask" ? <span>Ask</span> : null}
    </button>
  );
}

export function LifeOpsOverviewAssistantDock({
  onNavigate,
  openLifeOpsChat,
}: {
  onNavigate: (section: LifeOpsSection) => void;
  openLifeOpsChat: (
    text: string,
    selection?: Record<string, never>,
    options?: { select?: boolean },
  ) => void;
}) {
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-lg border border-border/16 bg-card/10 p-1.5"
      data-testid="lifeops-overview-assistant-dock"
    >
      {OVERVIEW_ASSISTANT_COMMANDS.map((command) => (
        <OverviewAssistantDockButton
          key={command.id}
          command={command}
          onLaunch={(launched) =>
            openLifeOpsChat(
              launched.prompt ?? assistantPrompt("command-brief"),
              {},
              { select: launched.select ?? true },
            )
          }
        />
      ))}
      <OverviewNavButton
        agentId="overview-open-assistant"
        label="Open Assistant"
        description="Open the full LifeOps assistant surface"
        aria-label="Open Assistant"
        title="Assistant"
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border/16 bg-bg/35 text-muted transition-colors hover:border-accent/30 hover:bg-bg-muted/45 hover:text-txt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        onClick={() => onNavigate("assistant")}
      >
        <ArrowRight className="h-4 w-4" aria-hidden />
      </OverviewNavButton>
    </div>
  );
}

function MetricCell({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <div className="min-w-0 border-t border-border/12 px-3 py-2 first:border-t-0 sm:border-l sm:border-t-0 sm:first:border-l-0">
      <div className="truncate text-[10px] font-semibold uppercase tracking-wide text-muted">
        {label}
      </div>
      <div
        className={`mt-1 truncate text-lg font-semibold tabular-nums ${tone ?? "text-txt"}`}
      >
        {value}
      </div>
    </div>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex items-center justify-center py-6 text-muted"
      role="status"
      aria-label={String(children)}
      title={String(children)}
    >
      <Sparkles className="h-4 w-4 opacity-70" aria-hidden />
      <span className="sr-only">{children}</span>
    </div>
  );
}

function OverviewStatusIcon({
  loading = false,
  label,
}: {
  loading?: boolean;
  label: string;
}) {
  return (
    <div
      className="flex items-center justify-center py-5 text-muted"
      role="status"
      aria-label={label}
      title={label}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        <Sparkles className="h-4 w-4 opacity-70" aria-hidden />
      )}
      <span className="sr-only">{label}</span>
    </div>
  );
}

function formatLabelList(labels: string[]): string {
  if (labels.length === 0) {
    return "";
  }
  if (labels.length === 1) {
    return labels[0];
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function sortPriorityMessages(
  messages: LifeOpsInboxMessage[],
): LifeOpsInboxMessage[] {
  return [...messages].sort((left, right) => {
    const leftPriority =
      typeof left.priorityScore === "number" ? left.priorityScore : 0;
    const rightPriority =
      typeof right.priorityScore === "number" ? right.priorityScore : 0;
    if (leftPriority !== rightPriority) {
      return rightPriority - leftPriority;
    }
    if (left.unread !== right.unread) {
      return left.unread ? -1 : 1;
    }
    return right.receivedAt.localeCompare(left.receivedAt);
  });
}

function hasCapabilityAccess(
  status: LifeOpsCapabilitiesStatus | null,
  capabilityId: string,
): boolean {
  const capability = findCapability(status, capabilityId);
  return capability?.state === "working" || capability?.state === "degraded";
}

function findCapability(
  status: LifeOpsCapabilitiesStatus | null,
  capabilityId: string,
) {
  return status?.capabilities.find((item) => item.id === capabilityId);
}

function hasGoogleCapability(
  status: LifeOpsGoogleConnectorStatus | null,
  capabilities: readonly LifeOpsGoogleCapability[],
): boolean {
  if (status?.connected !== true) {
    return false;
  }
  const granted = new Set(status.grantedCapabilities);
  return capabilities.some((capability) => granted.has(capability));
}

function hasXMessageAccess(status: LifeOpsXConnectorStatus | null): boolean {
  return status?.connected === true && (status.dmRead || status.dmInbound);
}

function TinyStatus({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${color}`}
        aria-hidden
      />
      <div className="min-w-0">
        <div className="text-sm font-medium leading-5 text-txt">{label}</div>
      </div>
    </div>
  );
}

function AssistantSignalButton({
  label,
  value,
  icon,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  tone: string;
  onClick: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `overview-signal-${overviewSlug(label)}`,
    role: "button",
    label,
    group: "lifeops-overview-signals",
    description: `Ask LifeOps about ${label}`,
  });
  return (
    <button
      ref={ref}
      type="button"
      aria-label={`Ask about ${label}`}
      title={label}
      className="flex min-h-12 min-w-0 items-center gap-2 rounded-lg border border-border/12 bg-bg/25 px-2.5 text-left transition-colors hover:border-accent/30 hover:bg-bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
      onClick={onClick}
      {...agentProps}
    >
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${tone}`}
        aria-hidden
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-semibold text-txt">
          {value}
        </span>
        <span className="sr-only">{label}</span>
      </span>
    </button>
  );
}

export function LifeOpsOverviewSignalsPanel({
  social,
  onNavigate,
}: {
  social?: { value: string };
  onNavigate: (section: LifeOpsSection) => void;
}) {
  if (!social) {
    return null;
  }

  return (
    <DashboardPanel
      title="Signals"
      icon={<Target className="h-4 w-4" aria-hidden />}
      action={
        <IconAction
          label="Ask about signals"
          icon={<Sparkles className="h-3.5 w-3.5" aria-hidden />}
          onClick={() => onNavigate("assistant")}
        />
      }
      className="xl:col-span-3"
    >
      <div className="grid gap-2" data-testid="lifeops-overview-signals">
        <AssistantSignalButton
          label="social"
          value={social.value}
          icon={<Share2 className="h-4 w-4" aria-hidden />}
          tone="bg-cyan-500/14 text-cyan-200"
          onClick={() => onNavigate("assistant")}
        />
      </div>
    </DashboardPanel>
  );
}

function CalendarEventRow({
  event,
  onClick,
}: {
  event: LifeOpsCalendarEvent;
  onClick: () => void;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `overview-event-${event.id}`,
    role: "list-item",
    label: event.title,
    group: "lifeops-overview-agenda",
    description: `Open the event ${event.title}`,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 items-start gap-3 py-2 text-left transition-colors hover:text-accent"
      {...agentProps}
    >
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-blue-400" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-txt">
          {event.title}
        </span>
      </span>
      <span className="shrink-0 text-[11px] font-medium text-blue-300">
        {event.isAllDay ? "All day" : formatClockTime(event.startAt)}
      </span>
    </button>
  );
}

function ReminderAgendaRow({
  reminder,
  onClick,
}: {
  reminder: LifeOpsActiveReminderView;
  onClick: () => void;
}) {
  const urgency = classifyReminder(reminder.scheduledFor);
  const style = URGENCY_STYLES[urgency];
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `overview-reminder-${reminder.ownerId}`,
    role: "list-item",
    label: reminder.title,
    group: "lifeops-overview-agenda",
    description: `Open the reminder ${reminder.title}`,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 items-start gap-3 py-2 text-left transition-colors hover:text-accent"
      {...agentProps}
    >
      <span
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${style.dot}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-txt">
          {reminder.title}
        </span>
      </span>
      <span className={`shrink-0 text-[11px] font-medium ${style.text}`}>
        {formatRelative(reminder.scheduledFor)}
      </span>
    </button>
  );
}

function InboxMessageRow({
  message,
  onClick,
}: {
  message: LifeOpsInboxMessage;
  onClick: () => void;
}) {
  const style = CHANNEL_STYLES[message.channel];
  const subject = message.subject?.trim() || `${style.label} message`;
  const rowTitle =
    subject === `${style.label} message`
      ? message.sender.displayName
      : `${message.sender.displayName} - ${subject}`;
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `overview-message-${message.id}`,
    role: "list-item",
    label: rowTitle,
    group: "lifeops-overview-inbox",
    description: `Open the message from ${message.sender.displayName}`,
  });
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 items-start gap-3 py-2 text-left transition-colors hover:text-accent"
      {...agentProps}
    >
      <span
        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${style.bg} ${style.text}`}
      >
        {style.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={`block truncate text-sm ${
            message.unread
              ? "font-semibold text-txt"
              : "font-medium text-txt/80"
          }`}
        >
          {rowTitle}
        </span>
      </span>
      <span className="shrink-0 text-[11px] font-medium text-muted">
        {formatRelative(message.receivedAt)}
      </span>
    </button>
  );
}

function TimelineRow({
  entry,
  onOpenEvent,
  onOpenReminder,
}: {
  entry: TimelineEntry;
  onOpenEvent: (event: LifeOpsCalendarEvent) => void;
  onOpenReminder: (reminder: LifeOpsActiveReminderView) => void;
}) {
  if (entry.kind === "event") {
    return (
      <CalendarEventRow
        event={entry.event}
        onClick={() => onOpenEvent(entry.event)}
      />
    );
  }
  return (
    <ReminderAgendaRow
      reminder={entry.reminder}
      onClick={() => onOpenReminder(entry.reminder)}
    />
  );
}

export function LifeOpsOverviewSection({
  onNavigate,
}: LifeOpsOverviewSectionProps) {
  const { t } = useApp();
  const { select } = useLifeOpsSelection();
  const { openLifeOpsChat } = useLifeOpsChatLauncher();
  const today = useMemo(() => new Date(), []);
  const greeting = useGreeting();
  const capabilities = useLifeOpsCapabilitiesStatus();
  const googleConnector = useGoogleLifeOpsConnector({
    includeAccounts: false,
    pollWhileDisconnected: false,
    side: "owner",
  });
  const xConnector = useLifeOpsXConnector("owner");

  const [overview, setOverview] = useState<LifeOpsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [social, setSocial] = useState<LifeOpsSocialHabitSummary | null>(null);
  const [socialLoading, setSocialLoading] = useState(false);
  const [socialError, setSocialError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setOverview(await client.getLifeOpsOverview());
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : t("lifeopsoverviewsection.loadFailed", {
              defaultValue: "Failed to load overview.",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadSocial = useCallback(async () => {
    setSocialLoading(true);
    setSocialError(null);
    try {
      setSocial(
        await client.getLifeOpsSocialHabitSummary({
          since: startOfLocalDayIso(),
          until: new Date().toISOString(),
          topN: 5,
        }),
      );
    } catch (cause) {
      setSocialError(
        cause instanceof Error && cause.message.trim().length > 0
          ? cause.message.trim()
          : "Social habits failed to load.",
      );
    } finally {
      setSocialLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
    void loadSocial();
  }, [loadOverview, loadSocial]);

  const calendar = useCalendarWeek({ viewMode: "week" });
  const messagesInbox = useInbox({
    maxResults: 40,
    channels: LIFEOPS_MESSAGE_CHANNELS,
    groupByThread: true,
    chatTypeFilter: ["dm"],
    sortByPriority: true,
  });
  const mailInbox = useInbox({
    maxResults: 40,
    channel: "gmail",
    channels: LIFEOPS_MAIL_CHANNELS,
    groupByThread: true,
    chatTypeFilter: ["dm"],
    sortByPriority: true,
  });

  const upcomingEvents = useMemo(() => {
    const now = Date.now();
    return [...calendar.events]
      .filter((event) => {
        const end = Date.parse(event.endAt);
        return Number.isFinite(end) && end >= now;
      })
      .sort((a, b) => a.startAt.localeCompare(b.startAt))
      .slice(0, 6);
  }, [calendar.events]);

  const summary = overview?.summary;
  const reminders = overview?.reminders ?? [];
  const activeReminders = reminders.slice(0, 6);
  const priorityMessages = useMemo(
    () => sortPriorityMessages(messagesInbox.messages),
    [messagesInbox.messages],
  );
  const priorityMail = useMemo(
    () => sortPriorityMessages(mailInbox.messages),
    [mailInbox.messages],
  );
  const unreadMessages = [...priorityMessages, ...priorityMail].filter(
    (message) => message.unread,
  );
  const hasUnread = unreadMessages.length > 0;
  const hasOverdue = (summary?.overdueOccurrenceCount ?? 0) > 0;
  const nextEvent = upcomingEvents[0] ?? null;
  const socialLabel = formatDurationSeconds(social?.totalSeconds);
  const browserActivityReady =
    findCapability(capabilities.status, "activity.browser")?.state ===
    "working";
  const socialAccess =
    (!socialError && browserActivityReady) || Boolean(social);
  const calendarAccess =
    hasGoogleCapability(googleConnector.status, [
      "google.calendar.read",
      "google.calendar.write",
    ]) || upcomingEvents.length > 0;
  const mailAccess =
    hasGoogleCapability(googleConnector.status, [
      "google.gmail.triage",
      "google.gmail.send",
    ]) || priorityMail.length > 0;
  const messagesAccess =
    hasXMessageAccess(xConnector.status) || priorityMessages.length > 0;
  const remindersAccess =
    hasCapabilityAccess(capabilities.status, "reminders.scheduler") ||
    activeReminders.length > 0 ||
    hasOverdue;
  const hasAnySignalWidget =
    socialAccess || calendarAccess || messagesAccess || mailAccess;
  const hasAnyOverviewAccess = hasAnySignalWidget || remindersAccess;
  const setupSignalsLoading =
    capabilities.loading || googleConnector.loading || xConnector.loading;
  const missingWidgets = useMemo(
    () =>
      [
        !socialAccess ? "Social" : null,
        !messagesAccess ? "Messages" : null,
        !mailAccess ? "Mail" : null,
        !calendarAccess ? "Calendar" : null,
      ].filter((value): value is string => Boolean(value)),
    [calendarAccess, mailAccess, messagesAccess, socialAccess],
  );
  const showSetupWarning = !setupSignalsLoading && missingWidgets.length > 0;
  const showNoAccessState =
    !setupSignalsLoading &&
    !loading &&
    !socialLoading &&
    !calendar.loading &&
    !messagesInbox.loading &&
    !mailInbox.loading &&
    !hasAnyOverviewAccess;
  const reminderMetricValue = activeReminders[0]
    ? formatRelative(activeReminders[0].scheduledFor)
    : hasOverdue
      ? `${summary?.overdueOccurrenceCount ?? 0} overdue`
      : (summary?.activeOccurrenceCount ?? 0) > 0
        ? `${summary?.activeOccurrenceCount ?? 0} active`
        : "Clear";
  const reminderMetricTone = hasOverdue
    ? "text-rose-300"
    : (summary?.activeOccurrenceCount ?? 0) > 0
      ? "text-amber-300"
      : "text-muted";

  const timeline = useMemo<TimelineEntry[]>(() => {
    return [
      ...upcomingEvents.map((event) => ({
        id: `event:${event.id}`,
        kind: "event" as const,
        sortAt: Date.parse(event.startAt),
        event,
      })),
      ...activeReminders.map((reminder) => ({
        id: `reminder:${reminder.ownerId}:${reminder.stepIndex}`,
        kind: "reminder" as const,
        sortAt: Date.parse(reminder.scheduledFor),
        reminder,
      })),
    ]
      .filter((entry) => Number.isFinite(entry.sortAt))
      .sort((left, right) => left.sortAt - right.sortAt)
      .slice(0, 7);
  }, [activeReminders, upcomingEvents]);

  const activeChannels = useMemo(() => {
    return CHANNEL_ORDER.filter((channel) =>
      priorityMessages.some((message) => message.channel === channel),
    );
  }, [priorityMessages]);

  const briefingLines = useMemo(() => {
    const lines: string[] = [];
    if (hasUnread) {
      lines.push("Messages need triage");
    }
    if (
      overview?.schedule?.nextMealLabel &&
      overview.schedule.nextMealWindowStartAt
    ) {
      lines.push(
        `${humanize(overview.schedule.nextMealLabel)} window starts ${formatClockTime(
          overview.schedule.nextMealWindowStartAt,
        )}`,
      );
    }
    return lines.slice(0, 5);
  }, [hasUnread, overview?.schedule]);
  const hasNowPanelContent = briefingLines.length > 0;
  const refresh = useCallback(() => {
    void loadOverview();
    void loadSocial();
    void capabilities.refresh();
    void googleConnector.refresh({ silent: true });
    void xConnector.refresh();
    void calendar.refresh();
    void messagesInbox.refresh();
    void mailInbox.refresh();
  }, [
    calendar.refresh,
    capabilities,
    googleConnector,
    loadSocial,
    loadOverview,
    mailInbox.refresh,
    messagesInbox.refresh,
    xConnector,
  ]);

  const openEvent = useCallback(
    (event: LifeOpsCalendarEvent) => {
      select({ eventId: event.id });
      onNavigate("calendar");
    },
    [onNavigate, select],
  );

  const openReminder = useCallback(
    (reminder: LifeOpsActiveReminderView) => {
      select({
        reminderId: reminder.ownerId,
        eventId: reminder.eventId ?? null,
      });
      onNavigate("reminders");
    },
    [onNavigate, select],
  );

  return (
    <div className="space-y-4" data-testid="lifeops-overview">
      <header className="border-b border-border/20 pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-muted">
              {greeting} / {formatFullDate(today)}
            </div>
            <h1 className="mt-2 max-w-4xl text-2xl font-semibold leading-tight text-txt sm:text-3xl">
              {buildHeadline({
                nextEvent,
                hasOverdue,
                hasUnread,
                hasAnyOverviewAccess,
              })}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <BrowserBridgeStatusChip onNavigate={onNavigate} />
            <OverviewNavButton
              agentId="overview-refresh"
              label="Refresh LifeOps dashboard"
              description="Refresh the LifeOps overview dashboard"
              aria-label="Refresh LifeOps dashboard"
              title="Refresh"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border/20 bg-bg/30 text-muted transition-colors hover:border-accent/30 hover:text-txt disabled:opacity-40"
              onClick={refresh}
              disabled={
                loading ||
                calendar.loading ||
                messagesInbox.loading ||
                mailInbox.loading
              }
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                aria-hidden
              />
            </OverviewNavButton>
          </div>
        </div>

        <div className="mt-4 grid overflow-hidden rounded-lg border border-border/16 bg-card/10">
          <MetricCell
            label="Reminders"
            value={reminderMetricValue}
            tone={reminderMetricTone}
          />
        </div>

        <div className="mt-3">
          <LifeOpsOverviewAssistantDock
            onNavigate={onNavigate}
            openLifeOpsChat={openLifeOpsChat}
          />
        </div>
      </header>

      {error ? (
        <div
          className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-300"
          title={error}
        >
          <TriangleAlert className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Activity unavailable
        </div>
      ) : null}

      {showSetupWarning ? (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/25 bg-amber-500/10 px-4 py-3"
          data-testid="lifeops-overview-setup-warning"
          title={`Missing: ${formatLabelList(missingWidgets)}`}
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="mt-0.5 shrink-0 text-amber-300">
              <TriangleAlert className="h-4 w-4" aria-hidden />
            </span>
            <span className="sr-only">
              {hasAnyOverviewAccess ? "Partial overview" : "Connect a source"}.
              Missing: {formatLabelList(missingWidgets)}
            </span>
          </div>
          <OverviewNavButton
            agentId="overview-open-setup"
            label="Open LifeOps setup"
            description="Open the LifeOps setup section"
            aria-label="Open LifeOps settings"
            title="Open setup"
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/16 bg-bg/50 text-txt transition-colors hover:border-accent/30 hover:text-accent"
            onClick={() => onNavigate("setup")}
          >
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">Open setup</span>
          </OverviewNavButton>
        </div>
      ) : null}

      {loading && !overview ? (
        <div className="flex items-center gap-2 py-4 text-xs text-muted">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          <span className="sr-only">Loading overview</span>
        </div>
      ) : null}

      {showNoAccessState ? (
        <div
          className="rounded-lg border border-border/16 bg-card/12 px-5 py-8 text-center"
          data-testid="lifeops-overview-empty-access"
        >
          <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-amber-500/12 text-amber-300">
            <TriangleAlert className="h-5 w-5" aria-hidden />
          </div>
          <span className="sr-only">Connect a source</span>
          <OverviewNavButton
            agentId="overview-open-settings"
            label="Open LifeOps settings"
            description="Open the LifeOps setup section to connect a source"
            className="mt-4 inline-flex h-9 w-9 items-center justify-center rounded-md border border-border/16 bg-bg/50 text-txt transition-colors hover:border-accent/30 hover:text-accent"
            onClick={() => onNavigate("setup")}
          >
            <ArrowRight className="h-4 w-4" aria-hidden />
            <span className="sr-only">Open Settings</span>
          </OverviewNavButton>
        </div>
      ) : null}

      {!showNoAccessState ? (
        <div className="grid items-start gap-4 xl:grid-cols-12">
          {hasNowPanelContent ? (
            <DashboardPanel
              title="Now"
              icon={<Flame className="h-4 w-4" aria-hidden />}
              className="xl:col-span-3"
            >
              <div className="space-y-3">
                {briefingLines.map((line) => (
                  <TinyStatus key={line} color="bg-accent" label={line} />
                ))}
              </div>
            </DashboardPanel>
          ) : null}

          <LifeOpsOverviewSignalsPanel
            social={
              socialAccess ? { value: socialLabel || "No data" } : undefined
            }
            onNavigate={onNavigate}
          />

          {calendarAccess ? (
            <DashboardPanel
              title="Upcoming"
              icon={<CalendarDays className="h-4 w-4" aria-hidden />}
              action={
                <IconAction
                  label="Calendar"
                  icon={<CalendarDays className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => onNavigate("calendar")}
                />
              }
              className="xl:col-span-4"
            >
              {calendar.loading && timeline.length === 0 ? (
                <OverviewStatusIcon loading label="Reading calendar" />
              ) : timeline.length === 0 ? (
                <EmptyState>Schedule clear</EmptyState>
              ) : (
                <div className="divide-y divide-border/10">
                  {timeline.map((entry) => (
                    <TimelineRow
                      key={entry.id}
                      entry={entry}
                      onOpenEvent={openEvent}
                      onOpenReminder={openReminder}
                    />
                  ))}
                </div>
              )}
            </DashboardPanel>
          ) : (
            <MissingSourceCard
              title="Calendar"
              ctaLabel="Connect Google"
              onCta={() => onNavigate("setup")}
              className="xl:col-span-4"
            />
          )}

          {messagesAccess ? (
            <DashboardPanel
              title="Priority Messages"
              icon={<MessageSquare className="h-4 w-4" aria-hidden />}
              action={
                <IconAction
                  label="Messages"
                  icon={<MessageSquare className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => onNavigate("messages")}
                />
              }
              className="xl:col-span-4"
            >
              <div className="mb-3 flex flex-wrap gap-2">
                {activeChannels.length === 0 ? (
                  <OverviewStatusIcon label="No live messages" />
                ) : (
                  activeChannels.slice(0, 5).map((channel) => {
                    const style = CHANNEL_STYLES[channel];
                    return (
                      <span
                        key={channel}
                        role="img"
                        aria-label={style.label}
                        title={style.label}
                        className={`inline-flex h-7 w-7 items-center justify-center rounded-full ${style.bg} ${style.text}`}
                      >
                        {style.icon}
                      </span>
                    );
                  })
                )}
              </div>
              {messagesInbox.loading && priorityMessages.length === 0 ? (
                <OverviewStatusIcon loading label="Reading messages" />
              ) : priorityMessages.length === 0 ? (
                <EmptyState>Messages clear</EmptyState>
              ) : (
                <div className="divide-y divide-border/10">
                  {priorityMessages.slice(0, 5).map((message) => (
                    <InboxMessageRow
                      key={message.id}
                      message={message}
                      onClick={() => {
                        select({ messageId: message.id });
                        onNavigate("messages");
                      }}
                    />
                  ))}
                </div>
              )}
            </DashboardPanel>
          ) : (
            <MissingSourceCard
              title="Messages"
              ctaLabel="Connect platform"
              onCta={() => onNavigate("setup")}
              className="xl:col-span-4"
            />
          )}

          {mailAccess ? (
            <DashboardPanel
              title="Priority Mail"
              icon={<Mail className="h-4 w-4" aria-hidden />}
              action={
                <IconAction
                  label="Mail"
                  icon={<Mail className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => onNavigate("mail")}
                />
              }
              className="xl:col-span-4"
            >
              {mailInbox.loading && priorityMail.length === 0 ? (
                <OverviewStatusIcon loading label="Reading mail" />
              ) : priorityMail.length === 0 ? (
                <EmptyState>Mail clear</EmptyState>
              ) : (
                <div className="divide-y divide-border/10">
                  {priorityMail.slice(0, 5).map((message) => (
                    <InboxMessageRow
                      key={message.id}
                      message={message}
                      onClick={() => {
                        select({ messageId: message.id });
                        onNavigate("mail");
                      }}
                    />
                  ))}
                </div>
              )}
            </DashboardPanel>
          ) : (
            <MissingSourceCard
              title="Mail"
              ctaLabel="Connect Google"
              onCta={() => onNavigate("setup")}
              className="xl:col-span-4"
            />
          )}

          {remindersAccess ? (
            <DashboardPanel
              title="Reminders"
              icon={<Target className="h-4 w-4" aria-hidden />}
              action={
                <IconAction
                  label="Reminders"
                  icon={<Target className="h-3.5 w-3.5" aria-hidden />}
                  onClick={() => onNavigate("reminders")}
                />
              }
              className="xl:col-span-4"
            >
              <div className="divide-y divide-border/10">
                {activeReminders.length === 0 ? (
                  <EmptyState>Reminders clear</EmptyState>
                ) : (
                  activeReminders
                    .slice(0, 4)
                    .map((reminder) => (
                      <ReminderAgendaRow
                        key={`${reminder.ownerId}:${reminder.stepIndex}`}
                        reminder={reminder}
                        onClick={() => openReminder(reminder)}
                      />
                    ))
                )}
              </div>
            </DashboardPanel>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
