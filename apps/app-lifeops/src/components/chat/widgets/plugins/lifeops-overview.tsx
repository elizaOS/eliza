

import type {
  LifeOpsActiveReminderView,
  LifeOpsCadence,
  LifeOpsDiscordDmPreview,
  LifeOpsGoalDefinition,
  LifeOpsGoalReview,
  LifeOpsOccurrenceExplanation,
  LifeOpsOccurrenceView,
  LifeOpsOverview,
  LifeOpsOverviewSection,
} from "@elizaos/shared/contracts/lifeops";
import {
  Bell,
  BellRing,
  Bot,
  CheckCircle2,
  Clock3,
  Cloud,
  ListTodo,
  Mail,
  MessageCircleMore,
  MessageSquareText,
  Moon,
  Phone,
  Send,
  Smartphone,
  Sparkles,
  SquareArrowOutUpRight,
} from "lucide-react";
import type { PropsWithChildren, ReactElement } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button } from "@elizaos/ui";
import { client } from "@elizaos/app-core/api";
import { isApiError } from "@elizaos/app-core/api/client-types-core";
import { useLifeOpsAppState } from "../../../../hooks/useLifeOpsAppState.js";
import { useDiscordConnector } from "../../../../hooks/useDiscordConnector.js";
import { useApp } from "@elizaos/app-core/state";
import { EmptyWidgetState, WidgetSection } from "@elizaos/app-core/components/chat/widgets/shared";
import type {
  ChatSidebarWidgetDefinition,
  ChatSidebarWidgetProps,
} from "@elizaos/app-core/components/chat/widgets/types";
import { GoogleGlanceSection } from "./lifeops.js";

const LIFEOPS_REFRESH_INTERVAL_MS = 15_000;
const MAX_SECTION_OCCURRENCES = 3;
const MAX_SECTION_GOALS = 2;
const MAX_SECTION_REMINDERS = 2;
const MAX_DISCORD_PREVIEWS = 3;
const NEXT_WINDOW_MS = 6 * 60 * 60 * 1000;

type SnoozePreset = "15m" | "30m" | "1h" | "tonight" | "tomorrow_morning";
type OccurrenceAction = "complete" | "skip";
type OccurrenceBucket = "now" | "next" | "upcoming";

const SNOOZE_PRESETS: Array<{ preset: SnoozePreset; label: string }> = [
  { preset: "15m", label: "15 min" },
  { preset: "30m", label: "30 min" },
  { preset: "1h", label: "1 hour" },
  { preset: "tonight", label: "Tonight" },
  { preset: "tomorrow_morning", label: "Tomorrow" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isLifeOpsRuntimeReady(args: {
  startupPhase?: string | null;
  agentState?: string | null;
  backendState?: string | null;
}): boolean {
  return (
    args.startupPhase === "ready" &&
    args.agentState === "running" &&
    args.backendState === "connected"
  );
}

function isTransientLifeOpsAvailabilityError(cause: unknown): boolean {
  return (
    isApiError(cause) &&
    cause.kind === "http" &&
    cause.status === 503 &&
    cause.path === "/api/lifeops/overview"
  );
}

function formatDateTime(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(parsed));
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function cadenceLabel(cadence: LifeOpsCadence): string {
  switch (cadence.kind) {
    case "once":
      return "One-off";
    case "daily":
      return "Daily";
    case "times_per_day":
      if (cadence.slots.length <= 1) {
        return "Daily";
      }
      if (cadence.slots.length === 2) {
        return "Twice daily";
      }
      return `${cadence.slots.length}x daily`;
    case "interval":
      return cadence.everyMinutes >= 60 && cadence.everyMinutes % 60 === 0
        ? `Every ${cadence.everyMinutes / 60}h`
        : `Every ${cadence.everyMinutes}m`;
    case "weekly":
      return cadence.weekdays.length <= 2 ? "Occasional" : "Weekly";
  }
}

function cadenceDetail(cadence: LifeOpsCadence): string | null {
  switch (cadence.kind) {
    case "once":
      return formatDateTime(cadence.dueAt);
    case "daily":
      return cadence.windows.length > 0 ? cadence.windows.join(", ") : null;
    case "times_per_day":
      return cadence.slots.map((slot) => slot.label).join(" / ");
    case "interval":
      return cadence.windows.length > 0 ? cadence.windows.join(", ") : null;
    case "weekly":
      return cadence.windows.length > 0 ? cadence.windows.join(", ") : null;
  }
}

function reviewStateLabel(
  reviewState: LifeOpsGoalDefinition["reviewState"],
): string {
  switch (reviewState) {
    case "needs_attention":
      return "Needs attention";
    case "on_track":
      return "On track";
    case "at_risk":
      return "At risk";
    default:
      return "Idle";
  }
}

function hasSectionContent(section: LifeOpsOverviewSection): boolean {
  return (
    section.occurrences.length > 0 ||
    section.goals.length > 0 ||
    section.reminders.length > 0
  );
}

function descriptionForOccurrence(
  occurrence: LifeOpsOccurrenceView,
): string | null {
  const description = occurrence.description.trim();
  return description.length > 0 ? description : null;
}

function sectionSummary(section: LifeOpsOverviewSection): string {
  const parts: string[] = [];
  if (section.summary.activeOccurrenceCount > 0) {
    parts.push(
      `${section.summary.activeOccurrenceCount} open ${section.summary.activeOccurrenceCount === 1 ? "item" : "items"}`,
    );
  }
  if (section.summary.activeGoalCount > 0) {
    parts.push(
      `${section.summary.activeGoalCount} active ${section.summary.activeGoalCount === 1 ? "goal" : "goals"}`,
    );
  }
  if (section.summary.activeReminderCount > 0) {
    parts.push(
      `${section.summary.activeReminderCount} live ${section.summary.activeReminderCount === 1 ? "reminder" : "reminders"}`,
    );
  }
  if (parts.length === 0) {
    return "No active items";
  }
  return parts.join(" • ");
}

function reminderChannelIcon(
  channel: LifeOpsActiveReminderView["channel"],
): ReactElement | null {
  switch (channel) {
    case "in_app":
      return <Bell className="h-3 w-3" />;
    case "telegram":
      return <Send className="h-3 w-3" />;
    case "sms":
      return <MessageSquareText className="h-3 w-3" />;
    case "voice":
      return <Phone className="h-3 w-3" />;
    case "discord":
      return <MessageCircleMore className="h-3 w-3" />;
    case "signal":
      return <Mail className="h-3 w-3" />;
    case "whatsapp":
      return <Smartphone className="h-3 w-3" />;
    case "imessage":
      return <Cloud className="h-3 w-3" />;
    default:
      return null;
  }
}

function occurrenceSortKey(occurrence: LifeOpsOccurrenceView): number {
  const candidates = [
    occurrence.dueAt,
    occurrence.snoozedUntil,
    occurrence.scheduledAt,
    occurrence.relevanceStartAt,
  ];
  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.MAX_SAFE_INTEGER;
}

function bucketOccurrences(
  occurrences: LifeOpsOccurrenceView[],
  now: Date,
): Record<OccurrenceBucket, LifeOpsOccurrenceView[]> {
  const buckets: Record<OccurrenceBucket, LifeOpsOccurrenceView[]> = {
    now: [],
    next: [],
    upcoming: [],
  };
  for (const occurrence of [...occurrences].sort(
    (left, right) => occurrenceSortKey(left) - occurrenceSortKey(right),
  )) {
    if (occurrence.state === "visible" || occurrence.state === "snoozed") {
      buckets.now.push(occurrence);
      continue;
    }
    const anchor = occurrenceSortKey(occurrence);
    if (anchor <= now.getTime() + NEXT_WINDOW_MS) {
      buckets.next.push(occurrence);
      continue;
    }
    buckets.upcoming.push(occurrence);
  }
  return buckets;
}

function DetailPanel({
  title,
  children,
}: PropsWithChildren<{ title: string }>) {
  return (
    <div className="mt-3 rounded-lg border border-border/50 bg-bg-accent/20 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
        {title}
      </div>
      <div className="mt-2 flex flex-col gap-2 text-xs leading-5 text-muted">
        {children}
      </div>
    </div>
  );
}

function OccurrenceExplanationPanel({
  explanation,
}: {
  explanation: LifeOpsOccurrenceExplanation;
}) {
  const lastReminder = explanation.summary.lastReminderAt
    ? `${formatDateTime(explanation.summary.lastReminderAt) ?? explanation.summary.lastReminderAt} via ${
        explanation.summary.lastReminderChannel ?? "unknown"
      } (${explanation.summary.lastReminderOutcome ?? "unknown"})`
    : "No reminder attempts yet";

  return (
    <DetailPanel title="Why this is showing up">
      <div>{explanation.summary.whyVisible}</div>
      <div>
        <span className="font-semibold text-txt">Original intent:</span>{" "}
        {explanation.summary.originalIntent}
      </div>
      <div>
        <span className="font-semibold text-txt">Source:</span>{" "}
        {explanation.summary.source}
      </div>
      <div>
        <span className="font-semibold text-txt">Last reminder:</span>{" "}
        {lastReminder}
      </div>
      {explanation.definitionPerformance.totalScheduledCount > 0 ? (
        <>
          <div>
            <span className="font-semibold text-txt">Performance:</span>{" "}
            {explanation.definitionPerformance.totalCompletedCount}/
            {explanation.definitionPerformance.totalScheduledCount} completed
            overall, current streak{" "}
            {explanation.definitionPerformance.currentOccurrenceStreak}, best{" "}
            {explanation.definitionPerformance.bestOccurrenceStreak}
          </div>
          <div>
            <span className="font-semibold text-txt">Last 7 days:</span>{" "}
            {formatPercent(
              explanation.definitionPerformance.last7Days.completionRate,
            )}{" "}
            completion across{" "}
            {explanation.definitionPerformance.last7Days.scheduledCount}{" "}
            scheduled item
            {explanation.definitionPerformance.last7Days.scheduledCount === 1
              ? ""
              : "s"}
            , {explanation.definitionPerformance.last7Days.perfectDayCount}{" "}
            perfect day
            {explanation.definitionPerformance.last7Days.perfectDayCount === 1
              ? ""
              : "s"}
          </div>
        </>
      ) : null}
      {explanation.summary.lastActionSummary ? (
        <div>
          <span className="font-semibold text-txt">Last action:</span>{" "}
          {explanation.summary.lastActionSummary}
        </div>
      ) : null}
      {explanation.linkedGoal ? (
        <div>
          <span className="font-semibold text-txt">Linked goal:</span>{" "}
          {explanation.linkedGoal.goal.title}
        </div>
      ) : null}
      {explanation.reminderPlan && explanation.reminderPlan.steps.length > 0 ? (
        <div>
          <span className="font-semibold text-txt">Reminders:</span>{" "}
          {explanation.reminderPlan.steps
            .map((step) => `${step.label} (${step.channel})`)
            .join(", ")}
        </div>
      ) : null}
    </DetailPanel>
  );
}

function GoalReviewPanel({ review }: { review: LifeOpsGoalReview }) {
  return (
    <DetailPanel title="Goal review">
      <div>{review.summary.explanation}</div>
      {typeof review.summary.progressScore === "number" ? (
        <div>
          <span className="font-semibold text-txt">Progress signal:</span>{" "}
          {Math.round(review.summary.progressScore * 100)}%
          {typeof review.summary.confidence === "number"
            ? ` at ${Math.round(review.summary.confidence * 100)}% confidence`
            : ""}
        </div>
      ) : null}
      {review.summary.groundingSummary ? (
        <div>
          <span className="font-semibold text-txt">Evaluation contract:</span>{" "}
          {review.summary.groundingSummary}
        </div>
      ) : null}
      {review.summary.evidenceSummary ? (
        <div>
          <span className="font-semibold text-txt">Evidence used:</span>{" "}
          {review.summary.evidenceSummary}
        </div>
      ) : null}
      <div>
        <span className="font-semibold text-txt">Support structure:</span>{" "}
        {review.summary.linkedDefinitionCount} linked{" "}
        {review.summary.linkedDefinitionCount === 1
          ? "definition"
          : "definitions"}
        , {review.summary.activeOccurrenceCount} active{" "}
        {review.summary.activeOccurrenceCount === 1
          ? "occurrence"
          : "occurrences"}
        , and {review.summary.completedLast7Days} completion
        {review.summary.completedLast7Days === 1 ? "" : "s"} in the last 7 days.
      </div>
      {review.suggestions.length > 0 ? (
        <div>
          <span className="font-semibold text-txt">Suggested next steps:</span>{" "}
          {review.suggestions.map((suggestion) => suggestion.title).join(" • ")}
        </div>
      ) : null}
      {review.summary.missingEvidence &&
      review.summary.missingEvidence.length > 0 ? (
        <div>
          <span className="font-semibold text-txt">Missing evidence:</span>{" "}
          {review.summary.missingEvidence.join(" • ")}
        </div>
      ) : null}
      {review.summary.lastActivityAt ? (
        <div>
          <span className="font-semibold text-txt">Last activity:</span>{" "}
          {formatDateTime(review.summary.lastActivityAt) ??
            review.summary.lastActivityAt}
        </div>
      ) : null}
    </DetailPanel>
  );
}

function SnoozeMenu({
  occurrenceId,
  disabled,
  onSnooze,
}: {
  occurrenceId: string;
  disabled: boolean;
  onSnooze: (occurrenceId: string, preset: SnoozePreset) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="h-7 px-2 text-xs-tight"
      >
        Snooze
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap gap-1">
      {SNOOZE_PRESETS.map(({ preset, label }) => (
        <Button
          key={preset}
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => {
            setOpen(false);
            void onSnooze(occurrenceId, preset);
          }}
          className="h-7 px-1.5 text-2xs"
        >
          {label}
        </Button>
      ))}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(false)}
        className="h-7 px-1.5 text-2xs text-muted"
      >
        Cancel
      </Button>
    </div>
  );
}

function OccurrenceRow({
  occurrence,
  actionPending,
  detailPending,
  explanation,
  isExpanded,
  onAction,
  onSnooze,
  onExplain,
}: {
  occurrence: LifeOpsOccurrenceView;
  actionPending: boolean;
  detailPending: boolean;
  explanation: LifeOpsOccurrenceExplanation | null;
  isExpanded: boolean;
  onAction: (occurrenceId: string, action: OccurrenceAction) => Promise<void>;
  onSnooze: (occurrenceId: string, preset: SnoozePreset) => Promise<void>;
  onExplain: (occurrenceId: string) => Promise<void>;
}) {
  const cadence = cadenceLabel(occurrence.cadence);
  const cadenceSecondary = cadenceDetail(occurrence.cadence);
  const dueLabel =
    formatDateTime(occurrence.dueAt) ?? formatDateTime(occurrence.scheduledAt);
  const description = descriptionForOccurrence(occurrence);
  const isClosed =
    occurrence.state === "completed" ||
    occurrence.state === "skipped" ||
    occurrence.state === "expired" ||
    occurrence.state === "muted";

  return (
    <div className="rounded-lg border border-border/50 bg-bg/70 p-2">
      <div className="flex items-start gap-2">
        <span
          className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${
            occurrence.priority <= 1 ? "bg-danger" : "bg-accent"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 truncate text-xs font-semibold text-txt">
              {occurrence.title}
            </span>
            <Badge variant="secondary" className="text-[10px]">
              {cadence}
            </Badge>
            {occurrence.state === "snoozed" ? (
              <Badge
                variant="secondary"
                className="text-[10px]"
                aria-label="Snoozed"
              >
                <Moon className="h-3 w-3" />
              </Badge>
            ) : null}
            {occurrence.subjectType === "agent" ? (
              <Badge
                variant="secondary"
                className="text-[10px]"
                aria-label="Agent"
              >
                <Bot className="h-3 w-3" />
              </Badge>
            ) : null}
          </div>
          {description ? (
            <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">
              {description}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-muted/80">
            {dueLabel ? <span>{dueLabel}</span> : null}
            {cadenceSecondary ? <span>{cadenceSecondary}</span> : null}
          </div>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {!isClosed ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionPending}
                  onClick={() => void onAction(occurrence.id, "complete")}
                  className="h-7 px-2 text-xs-tight"
                >
                  Done
                </Button>
                <SnoozeMenu
                  occurrenceId={occurrence.id}
                  disabled={actionPending}
                  onSnooze={onSnooze}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={actionPending}
                  onClick={() => void onAction(occurrence.id, "skip")}
                  className="h-7 px-2 text-xs-tight"
                >
                  Skip
                </Button>
              </>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              disabled={detailPending}
              onClick={() => void onExplain(occurrence.id)}
              className="h-7 px-2 text-xs-tight"
            >
              {isExpanded ? "Hide why" : "Why this?"}
            </Button>
          </div>
          {isExpanded && explanation ? (
            <OccurrenceExplanationPanel explanation={explanation} />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function GoalRow({
  goal,
  review,
  detailPending,
  isExpanded,
  onReview,
}: {
  goal: LifeOpsGoalDefinition;
  review: LifeOpsGoalReview | null;
  detailPending: boolean;
  isExpanded: boolean;
  onReview: (goalId: string) => Promise<void>;
}) {
  const cadence = isRecord(goal.cadence) ? goal.cadence : null;
  const cadenceText =
    cadence && typeof cadence.kind === "string" ? cadence.kind : null;
  const goalMetadata = isRecord(goal.metadata) ? goal.metadata : null;
  const grounding =
    goalMetadata && isRecord(goalMetadata.goalGrounding)
      ? (goalMetadata.goalGrounding as Record<string, unknown>)
      : null;
  const groundingSummary =
    grounding && typeof grounding.summary === "string"
      ? grounding.summary
      : null;
  const description = goal.description.trim() || groundingSummary || "";

  return (
    <div className="rounded-lg border border-border/50 bg-bg/70 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-txt">
          {goal.title}
        </span>
        <Badge variant="secondary" className="text-[10px]">
          {reviewStateLabel(goal.reviewState)}
        </Badge>
      </div>
      {description.length > 0 ? (
        <p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">
          {description}
        </p>
      ) : null}
      {cadenceText ? (
        <div className="mt-2 text-[11px] uppercase tracking-[0.08em] text-muted/80">
          {cadenceText}
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={detailPending}
          onClick={() => void onReview(goal.id)}
          className="h-7 px-2 text-xs-tight"
        >
          {isExpanded ? "Hide review" : "Review"}
        </Button>
      </div>
      {isExpanded && review ? <GoalReviewPanel review={review} /> : null}
    </div>
  );
}

function ReminderRow({ reminder }: { reminder: LifeOpsActiveReminderView }) {
  const scheduledFor = formatDateTime(reminder.scheduledFor);
  const dueAt = formatDateTime(reminder.dueAt);
  const channelIcon = reminderChannelIcon(reminder.channel);
  const channelLabel = reminder.channel.replace(/_/g, " ");

  return (
    <div className="rounded-lg border border-border/50 bg-bg/70 p-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-txt">
          {reminder.title}
        </span>
        <Badge
          variant="secondary"
          className="text-[10px]"
          aria-label={channelLabel}
        >
          {channelIcon ?? channelLabel}
        </Badge>
      </div>
      <div className="mt-1 text-xs text-muted">{reminder.stepLabel}</div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[0.08em] text-muted/80">
        {scheduledFor ? <span>{scheduledFor}</span> : null}
        {dueAt ? <span>Due {dueAt}</span> : null}
      </div>
    </div>
  );
}

function OccurrenceBucketBlock({
  title,
  icon,
  occurrences,
  actionState,
  detailState,
  occurrenceExplanations,
  expandedOccurrenceId,
  onOccurrenceAction,
  onSnoozeOccurrence,
  onExplainOccurrence,
}: {
  title: string;
  icon: ReactElement;
  occurrences: LifeOpsOccurrenceView[];
  actionState: string | null;
  detailState: string | null;
  occurrenceExplanations: Record<string, LifeOpsOccurrenceExplanation>;
  expandedOccurrenceId: string | null;
  onOccurrenceAction: (
    occurrenceId: string,
    action: OccurrenceAction,
  ) => Promise<void>;
  onSnoozeOccurrence: (
    occurrenceId: string,
    preset: SnoozePreset,
  ) => Promise<void>;
  onExplainOccurrence: (occurrenceId: string) => Promise<void>;
}) {
  if (occurrences.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-muted">{icon}</span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          {title}
        </span>
        <Badge variant="secondary" className="text-[10px]">
          {occurrences.length}
        </Badge>
      </div>
      {occurrences.slice(0, MAX_SECTION_OCCURRENCES).map((occurrence) => (
        <OccurrenceRow
          key={occurrence.id}
          occurrence={occurrence}
          actionPending={actionState?.endsWith(`:${occurrence.id}`) === true}
          detailPending={detailState === `occurrence:${occurrence.id}`}
          explanation={occurrenceExplanations[occurrence.id] ?? null}
          isExpanded={expandedOccurrenceId === occurrence.id}
          onAction={onOccurrenceAction}
          onSnooze={onSnoozeOccurrence}
          onExplain={onExplainOccurrence}
        />
      ))}
    </div>
  );
}

function GoalSection({
  goals,
  goalReviews,
  detailState,
  expandedGoalId,
  onReviewGoal,
}: {
  goals: LifeOpsGoalDefinition[];
  goalReviews: Record<string, LifeOpsGoalReview>;
  detailState: string | null;
  expandedGoalId: string | null;
  onReviewGoal: (goalId: string) => Promise<void>;
}) {
  if (goals.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-muted">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          Goals
        </span>
        <Badge variant="secondary" className="text-[10px]">
          {goals.length}
        </Badge>
      </div>
      {goals.slice(0, MAX_SECTION_GOALS).map((goal) => (
        <GoalRow
          key={goal.id}
          goal={goal}
          review={goalReviews[goal.id] ?? null}
          detailPending={detailState === `goal:${goal.id}`}
          isExpanded={expandedGoalId === goal.id}
          onReview={onReviewGoal}
        />
      ))}
    </div>
  );
}

function DiscordPreviewRow({ preview }: { preview: LifeOpsDiscordDmPreview }) {
  const snippet = preview.snippet?.trim() ?? "";
  return (
    <div className="flex items-center gap-2 px-0.5 py-0.5">
      <span
        className={`shrink-0 inline-block h-1.5 w-1.5 rounded-full ${preview.unread ? "bg-accent" : "bg-muted/30"}`}
      />
      <span className="min-w-0 flex-1 truncate text-2xs text-txt">
        {preview.label}
      </span>
      {snippet.length > 0 ? (
        <span className="min-w-0 max-w-[50%] truncate text-3xs text-muted">
          {snippet}
        </span>
      ) : null}
    </div>
  );
}

function DiscordMessagesGlance() {
  const connector = useDiscordConnector({ side: "owner" });
  const previews = connector.status?.dmInbox?.previews ?? [];
  if (!connector.status?.connected || previews.length === 0) {
    return null;
  }
  const unreadFirst = [...previews].sort(
    (a, b) => Number(b.unread) - Number(a.unread),
  );
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 px-0.5">
        <span className="text-muted">
          <MessageCircleMore className="h-3 w-3" />
        </span>
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted">
          Discord
        </span>
      </div>
      {unreadFirst.slice(0, MAX_DISCORD_PREVIEWS).map((preview) => (
        <DiscordPreviewRow
          key={`${preview.channelId ?? preview.label}`}
          preview={preview}
        />
      ))}
    </div>
  );
}

function ReminderSection({
  reminders,
}: {
  reminders: LifeOpsActiveReminderView[];
}) {
  if (reminders.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-muted">
          <BellRing className="h-3.5 w-3.5" />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          Reminders
        </span>
      </div>
      {reminders.slice(0, MAX_SECTION_REMINDERS).map((reminder) => (
        <ReminderRow
          key={`${reminder.ownerId}:${reminder.stepIndex}:${reminder.scheduledFor}`}
          reminder={reminder}
        />
      ))}
    </div>
  );
}

function AgentOpsSection({
  section,
  actionState,
  detailState,
  occurrenceExplanations,
  goalReviews,
  expandedOccurrenceId,
  expandedGoalId,
  onOccurrenceAction,
  onSnoozeOccurrence,
  onExplainOccurrence,
  onReviewGoal,
}: {
  section: LifeOpsOverviewSection;
  actionState: string | null;
  detailState: string | null;
  occurrenceExplanations: Record<string, LifeOpsOccurrenceExplanation>;
  goalReviews: Record<string, LifeOpsGoalReview>;
  expandedOccurrenceId: string | null;
  expandedGoalId: string | null;
  onOccurrenceAction: (
    occurrenceId: string,
    action: OccurrenceAction,
  ) => Promise<void>;
  onSnoozeOccurrence: (
    occurrenceId: string,
    preset: SnoozePreset,
  ) => Promise<void>;
  onExplainOccurrence: (occurrenceId: string) => Promise<void>;
  onReviewGoal: (goalId: string) => Promise<void>;
}) {
  if (!hasSectionContent(section)) {
    return null;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 px-0.5">
        <span className="text-muted">
          <Bot className="h-3.5 w-3.5" />
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          Agent ops
        </span>
        <Badge variant="secondary" className="text-[10px]">
          {section.summary.activeOccurrenceCount +
            section.summary.activeGoalCount +
            section.summary.activeReminderCount}
        </Badge>
      </div>
      <p className="px-0.5 text-xs text-muted">
        {sectionSummary(section)}
      </p>
      {section.occurrences
        .slice(0, MAX_SECTION_OCCURRENCES)
        .map((occurrence) => (
          <OccurrenceRow
            key={occurrence.id}
            occurrence={occurrence}
            actionPending={actionState?.endsWith(`:${occurrence.id}`) === true}
            detailPending={detailState === `occurrence:${occurrence.id}`}
            explanation={occurrenceExplanations[occurrence.id] ?? null}
            isExpanded={expandedOccurrenceId === occurrence.id}
            onAction={onOccurrenceAction}
            onSnooze={onSnoozeOccurrence}
            onExplain={onExplainOccurrence}
          />
        ))}
      {section.goals.slice(0, MAX_SECTION_GOALS).map((goal) => (
        <GoalRow
          key={goal.id}
          goal={goal}
          review={goalReviews[goal.id] ?? null}
          detailPending={detailState === `goal:${goal.id}`}
          isExpanded={expandedGoalId === goal.id}
          onReview={onReviewGoal}
        />
      ))}
      {section.reminders.slice(0, MAX_SECTION_REMINDERS).map((reminder) => (
        <ReminderRow
          key={`${reminder.ownerId}:${reminder.stepIndex}:${reminder.scheduledFor}`}
          reminder={reminder}
        />
      ))}
    </div>
  );
}

export function LifeOpsOverviewSidebarWidget(_props: ChatSidebarWidgetProps) {
  const lifeOpsApp = useLifeOpsAppState();
  const { agentStatus, backendConnection, startupPhase, setTab, t } =
    useApp();
  const [overview, setOverview] = useState<LifeOpsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<string | null>(null);
  const [detailState, setDetailState] = useState<string | null>(null);
  const [expandedOccurrenceId, setExpandedOccurrenceId] = useState<
    string | null
  >(null);
  const [expandedGoalId, setExpandedGoalId] = useState<string | null>(null);
  const [occurrenceExplanations, setOccurrenceExplanations] = useState<
    Record<string, LifeOpsOccurrenceExplanation>
  >({});
  const [goalReviews, setGoalReviews] = useState<
    Record<string, LifeOpsGoalReview>
  >({});
  const runtimeReady = isLifeOpsRuntimeReady({
    startupPhase: lifeOpsApp.enabled ? startupPhase : null,
    agentState: agentStatus?.state ?? null,
    backendState: backendConnection?.state ?? null,
  });

  const loadOverview = useCallback(
    async (silent = false) => {
      if (!runtimeReady) {
        setLoading(false);
        return;
      }
      if (!silent) {
        setLoading(true);
      }
      const nextOverview = await client.getLifeOpsOverview();
      setOverview(nextOverview);
      setError(null);
      setLoading(false);
    },
    [runtimeReady],
  );

  useEffect(() => {
    if (!runtimeReady) {
      setLoading(false);
      setError(null);
      return;
    }
    let active = true;

    void (async () => {
      try {
        await loadOverview(false);
      } catch (cause) {
        if (isTransientLifeOpsAvailabilityError(cause)) {
          setError(null);
          setLoading(false);
          return;
        }
        const message =
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Life ops failed to refresh.";
        setOverview(null);
        setError(message);
        setLoading(false);
      }
    })();

    const intervalId = window.setInterval(() => {
      if (!active) {
        return;
      }
      void (async () => {
        try {
          await loadOverview(true);
        } catch (cause) {
          if (isTransientLifeOpsAvailabilityError(cause)) {
            setError(null);
            return;
          }
          const message =
            cause instanceof Error && cause.message.trim().length > 0
              ? cause.message.trim()
              : "Life ops failed to refresh.";
          setError(message);
        }
      })();
    }, LIFEOPS_REFRESH_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [loadOverview, runtimeReady]);

  const onOccurrenceAction = useCallback(
    async (occurrenceId: string, action: OccurrenceAction) => {
      const token = `${action}:${occurrenceId}`;
      setActionState(token);
      try {
        if (action === "complete") {
          await client.completeLifeOpsOccurrence(occurrenceId, {});
        } else {
          await client.skipLifeOpsOccurrence(occurrenceId);
        }
        await loadOverview(true);
      } catch (cause) {
        setError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Life ops update failed.",
        );
      } finally {
        setActionState((current) => (current === token ? null : current));
      }
    },
    [loadOverview],
  );

  const onSnoozeOccurrence = useCallback(
    async (occurrenceId: string, preset: SnoozePreset) => {
      const token = `snooze:${occurrenceId}`;
      setActionState(token);
      try {
        await client.snoozeLifeOpsOccurrence(occurrenceId, { preset });
        await loadOverview(true);
      } catch (cause) {
        setError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Snooze failed.",
        );
      } finally {
        setActionState((current) => (current === token ? null : current));
      }
    },
    [loadOverview],
  );

  const onExplainOccurrence = useCallback(
    async (occurrenceId: string) => {
      if (expandedOccurrenceId === occurrenceId) {
        setExpandedOccurrenceId(null);
        return;
      }
      setExpandedGoalId(null);
      setDetailState(`occurrence:${occurrenceId}`);
      try {
        const explanation =
          occurrenceExplanations[occurrenceId] ??
          (await client.getLifeOpsOccurrenceExplanation(occurrenceId));
        setOccurrenceExplanations((current) => ({
          ...current,
          [occurrenceId]: explanation,
        }));
        setExpandedOccurrenceId(occurrenceId);
        setError(null);
      } catch (cause) {
        setError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Life ops explanation failed.",
        );
      } finally {
        setDetailState((current) =>
          current === `occurrence:${occurrenceId}` ? null : current,
        );
      }
    },
    [expandedOccurrenceId, occurrenceExplanations],
  );

  const onReviewGoal = useCallback(
    async (goalId: string) => {
      if (expandedGoalId === goalId) {
        setExpandedGoalId(null);
        return;
      }
      setExpandedOccurrenceId(null);
      setDetailState(`goal:${goalId}`);
      try {
        const review =
          goalReviews[goalId] ?? (await client.reviewLifeOpsGoal(goalId));
        setGoalReviews((current) => ({
          ...current,
          [goalId]: review,
        }));
        setExpandedGoalId(goalId);
        setError(null);
        setOverview((current) => {
          if (!current) {
            return current;
          }
          const replaceGoal = (goals: LifeOpsGoalDefinition[]) =>
            goals.map((goal) =>
              goal.id === review.goal.id ? review.goal : goal,
            );
          return {
            ...current,
            goals: replaceGoal(current.goals),
            owner: {
              ...current.owner,
              goals: replaceGoal(current.owner.goals),
            },
            agentOps: {
              ...current.agentOps,
              goals: replaceGoal(current.agentOps.goals),
            },
          };
        });
      } catch (cause) {
        setError(
          cause instanceof Error && cause.message.trim().length > 0
            ? cause.message.trim()
            : "Goal review failed.",
        );
      } finally {
        setDetailState((current) =>
          current === `goal:${goalId}` ? null : current,
        );
      }
    },
    [expandedGoalId, goalReviews],
  );

  const hasAnyContent = overview
    ? hasSectionContent(overview.owner) || hasSectionContent(overview.agentOps)
    : false;
  const ownerSection = overview?.owner ?? null;
  const agentOpsSection = overview?.agentOps ?? overview?.owner ?? null;
  const ownerBuckets = useMemo(
    () => bucketOccurrences(overview?.owner.occurrences ?? [], new Date()),
    [overview?.owner.occurrences],
  );

  if (lifeOpsApp.loading || !lifeOpsApp.enabled) {
    return null;
  }

  return (
    <WidgetSection
      title="Life Ops"
      icon={<ListTodo className="h-4 w-4" />}
      action={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setTab("lifeops")}
          aria-label={t("lifeopsoverview.OpenView", { defaultValue: "Open LifeOps view" })}
          className="h-6 w-6 p-0"
        >
          <SquareArrowOutUpRight className="h-3.5 w-3.5" />
        </Button>
      }
      testId="chat-widget-lifeops-overview"
    >
      {!hasAnyContent ? (
        <EmptyWidgetState
          icon={<CheckCircle2 className="h-8 w-8" />}
          title={loading ? "Refreshing life ops…" : "No life ops yet"}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <OccurrenceBucketBlock
            title="Now"
            icon={<ListTodo className="h-3.5 w-3.5" />}
            occurrences={ownerBuckets.now}
            actionState={actionState}
            detailState={detailState}
            occurrenceExplanations={occurrenceExplanations}
            expandedOccurrenceId={expandedOccurrenceId}
            onOccurrenceAction={onOccurrenceAction}
            onSnoozeOccurrence={onSnoozeOccurrence}
            onExplainOccurrence={onExplainOccurrence}
          />
          <OccurrenceBucketBlock
            title="Next"
            icon={<Clock3 className="h-3.5 w-3.5" />}
            occurrences={ownerBuckets.next}
            actionState={actionState}
            detailState={detailState}
            occurrenceExplanations={occurrenceExplanations}
            expandedOccurrenceId={expandedOccurrenceId}
            onOccurrenceAction={onOccurrenceAction}
            onSnoozeOccurrence={onSnoozeOccurrence}
            onExplainOccurrence={onExplainOccurrence}
          />
          <OccurrenceBucketBlock
            title="Upcoming"
            icon={<Clock3 className="h-3.5 w-3.5" />}
            occurrences={ownerBuckets.upcoming}
            actionState={actionState}
            detailState={detailState}
            occurrenceExplanations={occurrenceExplanations}
            expandedOccurrenceId={expandedOccurrenceId}
            onOccurrenceAction={onOccurrenceAction}
            onSnoozeOccurrence={onSnoozeOccurrence}
            onExplainOccurrence={onExplainOccurrence}
          />
          <GoalSection
            goals={ownerSection?.goals ?? []}
            goalReviews={goalReviews}
            detailState={detailState}
            expandedGoalId={expandedGoalId}
            onReviewGoal={onReviewGoal}
          />
          <ReminderSection reminders={ownerSection?.reminders ?? []} />
          {agentOpsSection ? (
            <AgentOpsSection
              section={agentOpsSection}
              actionState={actionState}
              detailState={detailState}
              occurrenceExplanations={occurrenceExplanations}
              goalReviews={goalReviews}
              expandedOccurrenceId={expandedOccurrenceId}
              expandedGoalId={expandedGoalId}
              onOccurrenceAction={onOccurrenceAction}
              onSnoozeOccurrence={onSnoozeOccurrence}
              onExplainOccurrence={onExplainOccurrence}
              onReviewGoal={onReviewGoal}
            />
          ) : null}
        </div>
      )}
      {error ? (
        <div className="mt-3 text-xs text-danger">{error}</div>
      ) : null}
    </WidgetSection>
  );
}

export const LIFEOPS_OVERVIEW_WIDGETS: ChatSidebarWidgetDefinition[] = [
  {
    id: "lifeops.overview",
    pluginId: "lifeops",
    order: 90,
    defaultEnabled: true,
    Component: LifeOpsOverviewSidebarWidget,
  },
];
