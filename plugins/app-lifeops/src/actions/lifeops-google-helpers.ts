import { hasOwnerAccess } from "@elizaos/agent/security/access";
import type {
  Action,
  IAgentRuntime,
  Memory,
  ProviderDataRecord,
} from "@elizaos/core";
import {
  assertActiveTrajectoryForLlmCall,
  ModelType,
  runWithTrajectoryContext,
} from "@elizaos/core";
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsGmailBatchReplyDraftsFeed,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailNeedsResponseFeed,
  LifeOpsGmailRecommendationsFeed,
  LifeOpsGmailReplyDraft,
  LifeOpsGmailSearchFeed,
  LifeOpsGmailTriageFeed,
  LifeOpsGoogleConnectorStatus,
  LifeOpsNextCalendarEventContext,
  LifeOpsOccurrenceView,
  LifeOpsOverview,
} from "../contracts/index.js";
import type { LifeOpsService } from "../lifeops/service.js";
import { getLocalDateKey, getZonedDateParts } from "../lifeops/time.js";
import { parseJsonModelRecord } from "../utils/json-model-output.js";

export const INTERNAL_URL = new URL("http://127.0.0.1/");

// Truncate snippet/preview text and append an ellipsis when we actually cut.
// Without the marker the slice looks like a sentence the sender wrote, which
// confuses readers when content gets clipped mid-word.
function truncateForPreview(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength).trimEnd()}…`;
}

// Build a "Display Name <email@host>" string when both are available, or
// fall back to whichever field is set. Without explicit email rendering the
// reader can't see who actually sent the message — only the display name,
// which is often spoofable or generic ("Google", "Notifications").
function formatEmailSender(
  display: string | null | undefined,
  email: string | null | undefined,
): string {
  const trimmedDisplay = typeof display === "string" ? display.trim() : "";
  const trimmedEmail = typeof email === "string" ? email.trim() : "";
  if (trimmedDisplay && trimmedEmail && trimmedDisplay !== trimmedEmail) {
    return `${trimmedDisplay} <${trimmedEmail}>`;
  }
  return trimmedDisplay || trimmedEmail || "unknown";
}

export function toActionData<T extends object>(data: T): ProviderDataRecord {
  return data as unknown as ProviderDataRecord;
}

export function messageSource(message: Memory): string | null {
  const source = (message.content as Record<string, unknown> | undefined)
    ?.source;
  return typeof source === "string" ? source : null;
}

export function messageText(message: Memory): string {
  const text = (message.content as Record<string, unknown> | undefined)?.text;
  return typeof text === "string" ? text : "";
}

type LifeOpsModelType = (typeof ModelType)[keyof typeof ModelType];

type LifeOpsModelCallArgs = {
  runtime: IAgentRuntime;
  prompt: string;
  actionType: string;
  failureMessage: string;
  source: string;
  modelType?: LifeOpsModelType;
  purpose?: string;
};

export type LifeOpsJsonModelResult<
  T extends Record<string, unknown> = Record<string, unknown>,
> = {
  rawResponse: string;
  parsed: T | null;
};

export function parseLifeOpsJsonRecord<
  T extends Record<string, unknown> = Record<string, unknown>,
>(rawResponse: string): T | null {
  return parseJsonModelRecord<T>(rawResponse);
}

export async function runLifeOpsTextModel(
  args: LifeOpsModelCallArgs,
): Promise<string | null> {
  if (typeof args.runtime.useModel !== "function") {
    return null;
  }

  const modelType = args.modelType ?? ModelType.TEXT_LARGE;
  assertActiveTrajectoryForLlmCall({
    actionType: args.actionType,
    modelType: String(modelType),
    purpose: args.purpose ?? "planner",
  });

  try {
    const result = await runWithTrajectoryContext(
      { purpose: args.purpose ?? `lifeops-${args.actionType}` },
      () =>
        args.runtime.useModel(modelType, {
          prompt: args.prompt,
        }),
    );
    return typeof result === "string" ? result : "";
  } catch (error) {
    args.runtime.logger?.warn?.(
      {
        src: args.source,
        error: error instanceof Error ? error.message : String(error),
      },
      args.failureMessage,
    );
    return null;
  }
}

export async function runLifeOpsJsonModel<
  T extends Record<string, unknown> = Record<string, unknown>,
>(args: LifeOpsModelCallArgs): Promise<LifeOpsJsonModelResult<T> | null> {
  const rawResponse = await runLifeOpsTextModel(args);
  if (rawResponse === null) {
    return null;
  }

  return {
    rawResponse,
    parsed: parseLifeOpsJsonRecord<T>(rawResponse),
  };
}

export async function hasLifeOpsAccess(
  runtime: Parameters<NonNullable<Action["validate"]>>[0],
  message: Memory,
): Promise<boolean> {
  if (
    !runtime ||
    typeof runtime.agentId !== "string" ||
    !message ||
    typeof message.entityId !== "string" ||
    message.entityId.length === 0
  ) {
    return false;
  }
  return hasOwnerAccess(runtime, message);
}

export function detailString(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function detailNumber(
  details: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = details?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function detailBoolean(
  details: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = details?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export function detailObject(
  details: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const value = details?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function detailArray(
  details: Record<string, unknown> | undefined,
  key: string,
): unknown[] | undefined {
  const value = details?.[key];
  return Array.isArray(value) ? value : undefined;
}

export function dayRange(offset: number) {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  const start = new Date(base.getTime() + offset * 86_400_000);
  return {
    timeMin: start.toISOString(),
    timeMax: new Date(start.getTime() + 86_400_000).toISOString(),
  };
}

export function weekRange() {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  return {
    timeMin: base.toISOString(),
    timeMax: new Date(base.getTime() + 7 * 86_400_000).toISOString(),
  };
}

export function futureRange(days: number) {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  return {
    timeMin: base.toISOString(),
    timeMax: new Date(base.getTime() + days * 86_400_000).toISOString(),
  };
}

function formatCalendarDatePart(
  date: Date,
  timeZone: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    ...options,
  }).format(date);
}

function getCalendarYearForDisplay(date: Date, timeZone?: string): number {
  return Number(
    formatCalendarDatePart(date, timeZone, {
      year: "numeric",
    }),
  );
}

export function formatCalendarEventDateTime(
  event: Pick<LifeOpsCalendarEvent, "startAt" | "timezone">,
  options?: {
    includeYear?: boolean;
    includeTimeZoneName?: boolean;
    numericDate?: boolean;
  },
): string {
  const start = new Date(event.startAt);
  const timeZone = event.timezone || undefined;
  const currentYear = getCalendarYearForDisplay(new Date(), timeZone);
  const eventYear = getCalendarYearForDisplay(start, timeZone);
  const includeYear = options?.includeYear ?? eventYear !== currentYear;
  const month = options?.numericDate ? "numeric" : "short";
  const datePart = formatCalendarDatePart(start, timeZone, {
    month,
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  });
  const timePart = formatCalendarDatePart(start, timeZone, {
    hour: "numeric",
    minute: "2-digit",
    ...(options?.includeTimeZoneName ? { timeZoneName: "short" } : {}),
  });
  return `${datePart}, ${timePart}`;
}

function formatEventTime(event: LifeOpsCalendarEvent): string {
  if (event.isAllDay) {
    return "all day";
  }
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  // Always include the date so a list of multiple events doesn't show
  // identical-looking time-only entries with no way to tell which day
  // they belong to. Year is included only when the event is in a year
  // other than the current one to keep the common case readable.
  const timeZone = event.timezone || undefined;
  const currentYear = getCalendarYearForDisplay(new Date(), timeZone);
  const eventYear = getCalendarYearForDisplay(start, timeZone);
  const includeYear = eventYear !== currentYear;
  const datePart = formatCalendarDatePart(start, timeZone, {
    month: "short",
    day: "numeric",
    ...(includeYear ? { year: "numeric" } : {}),
  });
  const startTime = formatCalendarDatePart(start, timeZone, {
    hour: "numeric",
    minute: "2-digit",
  });
  const endTime = formatCalendarDatePart(end, timeZone, {
    hour: "numeric",
    minute: "2-digit",
  });
  return `${datePart}, ${startTime} – ${endTime}`;
}

export function formatRelativeMinutes(minutes: number): string {
  if (minutes <= 0) {
    return "now";
  }
  if (minutes < 60) {
    return `in ${Math.round(minutes)} min`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = Math.round(minutes % 60);
  return remainingMinutes === 0
    ? `in ${hours}h`
    : `in ${hours}h ${remainingMinutes}m`;
}

export function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - Date.parse(isoDate);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatCalendarFeed(
  feed: LifeOpsCalendarFeed,
  label: string,
): string {
  if (feed.events.length === 0) {
    return `No events ${label}.`;
  }
  const lines: string[] = [`Events ${label}:`];
  for (const event of feed.events) {
    const time = formatEventTime(event);
    const parts = [`- **${event.title}** (${time})`];
    if (event.location) {
      parts.push(`  Location: ${event.location}`);
    }
    if (event.attendees.length > 0) {
      const names = event.attendees
        .slice(0, 4)
        .map((attendee) => attendee.displayName || attendee.email || "unknown")
        .join(", ");
      const suffix =
        event.attendees.length > 4
          ? ` +${event.attendees.length - 4} more`
          : "";
      parts.push(`  With: ${names}${suffix}`);
    }
    if (event.conferenceLink) {
      parts.push(`  Video: ${event.conferenceLink}`);
    }
    lines.push(parts.join("\n"));
  }
  return lines.join("\n");
}

export function formatNextEventContext(
  context: LifeOpsNextCalendarEventContext,
): string {
  if (!context.event) {
    return "No upcoming events on your calendar.";
  }
  const lines = [
    `**Next event: ${context.event.title}** (${formatEventTime(context.event)})`,
  ];
  if (context.startsInMinutes !== null) {
    lines[0] += ` — ${formatRelativeMinutes(context.startsInMinutes)}`;
  }
  if (context.location) {
    lines.push(`Location: ${context.location}`);
  }
  if (context.conferenceLink) {
    lines.push(`Video link: ${context.conferenceLink}`);
  }
  if (context.attendeeNames.length > 0) {
    lines.push(`Attendees: ${context.attendeeNames.join(", ")}`);
  }
  if (context.preparationChecklist.length > 0) {
    lines.push("Preparation:");
    for (const item of context.preparationChecklist) {
      lines.push(`- ${item}`);
    }
  }
  if (context.linkedMail.length > 0) {
    lines.push("Related emails:");
    for (const mail of context.linkedMail.slice(0, 3)) {
      const snippet = mail.snippet
        ? ` (${truncateForPreview(mail.snippet, 60)})`
        : "";
      lines.push(`- "${mail.subject}" from ${mail.from}${snippet}`);
    }
  }
  return lines.join("\n");
}

export function formatEmailTriage(feed: LifeOpsGmailTriageFeed): string {
  if (feed.messages.length === 0) {
    return "No important emails right now.";
  }
  const { summary } = feed;
  const parts: string[] = [];
  if (summary.unreadCount > 0) {
    parts.push(`${summary.unreadCount} unread`);
  }
  if (summary.importantNewCount > 0) {
    parts.push(`${summary.importantNewCount} important`);
  }
  if (summary.likelyReplyNeededCount > 0) {
    parts.push(`${summary.likelyReplyNeededCount} likely need a reply`);
  }
  const lines = [
    parts.length > 0 ? `Email inbox: ${parts.join(", ")}.` : "Email inbox:",
  ];
  for (const message of feed.messages.slice(0, 8)) {
    const badges: string[] = [];
    if (message.isImportant) {
      badges.push("important");
    }
    if (message.likelyReplyNeeded) {
      badges.push("reply needed");
    }
    const badgeText = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
    const sender = formatEmailSender(message.from, message.fromEmail);
    lines.push(`- **${message.subject}**${badgeText}`);
    lines.push(`  From: ${sender} · ${formatRelativeTime(message.receivedAt)}`);
    if (message.snippet) {
      lines.push(`  ${truncateForPreview(message.snippet, 100)}`);
    }
  }
  return lines.join("\n");
}

export function formatEmailNeedsResponse(
  feed: LifeOpsGmailNeedsResponseFeed,
): string {
  if (feed.messages.length === 0) {
    return "No emails look like they need a reply right now.";
  }
  const lines = [
    `Emails that likely need a reply: ${feed.summary.totalCount}.`,
  ];
  for (const message of feed.messages.slice(0, 8)) {
    const sender = formatEmailSender(message.from, message.fromEmail);
    lines.push(
      `- **${message.subject}** from ${sender} · ${formatRelativeTime(message.receivedAt)}`,
    );
    if (message.snippet) {
      lines.push(`  ${truncateForPreview(message.snippet, 120)}`);
    }
  }
  return lines.join("\n");
}

export function formatGmailRecommendations(
  feed: LifeOpsGmailRecommendationsFeed,
): string {
  if (feed.recommendations.length === 0) {
    return "No Gmail actions are recommended from the current email set.";
  }
  const lines = [`Recommended Gmail actions: ${feed.summary.totalCount}.`];
  for (const recommendation of feed.recommendations.slice(0, 6)) {
    const operation = recommendation.operation
      ? ` (${recommendation.operation.replace("_", " ")})`
      : "";
    lines.push(
      `- **${recommendation.title}**${operation}: ${recommendation.affectedCount} message${recommendation.affectedCount === 1 ? "" : "s"}`,
    );
    lines.push(`  ${recommendation.rationale}`);
    for (const sample of recommendation.sampleMessages.slice(0, 2)) {
      const sender = formatEmailSender(sample.from, sample.fromEmail);
      lines.push(`  - ${sample.subject} from ${sender}`);
    }
  }
  return lines.join("\n");
}

function describeEmailSearchQuery(query: string): string {
  const parts = query
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return `"${query}"`;
  }

  const sender = parts
    .find((part) => /^from:/i.test(part))
    ?.replace(/^from:/i, "")
    .replace(/^"|"$/g, "");
  const newerThan = parts
    .find((part) => /^newer_than:/i.test(part))
    ?.replace(/^newer_than:/i, "");
  const before = parts
    .find((part) => /^before:/i.test(part))
    ?.replace(/^before:/i, "");
  const after = parts
    .find((part) => /^after:/i.test(part))
    ?.replace(/^after:/i, "");
  const isUnread = parts.some((part) => /^is:unread$/i.test(part));
  const isImportant = parts.some((part) => /^is:important$/i.test(part));
  const keywords = parts.filter(
    (part) =>
      !/^(from|newer_than|before|after|is):/i.test(part) &&
      part.trim().length > 0,
  );

  const descriptions: string[] = [];
  const formatRelativeWindow = (value: string) => {
    const match = value.match(/^(\d+)([dmy])$/i);
    if (!match) {
      return value;
    }
    const unitToken = match[2];
    if (!unitToken) {
      return value;
    }
    const unit =
      unitToken.toLowerCase() === "d"
        ? "day"
        : unitToken.toLowerCase() === "m"
          ? "month"
          : "year";
    const amountToken = match[1];
    if (!amountToken) {
      return value;
    }
    const amount = Number(amountToken);
    return `${amount} ${unit}${amount === 1 ? "" : "s"}`;
  };
  if (sender) {
    descriptions.push(`sender "${sender}"`);
  }
  if (keywords.length > 0) {
    descriptions.push(`matching "${keywords.join(" ")}"`);
  }
  if (newerThan) {
    descriptions.push(`from the last ${formatRelativeWindow(newerThan)}`);
  }
  if (after) {
    descriptions.push(`after ${after}`);
  }
  if (before) {
    descriptions.push(`before ${before}`);
  }
  if (isUnread) {
    descriptions.push("that are unread");
  }
  if (isImportant) {
    descriptions.push("that are marked important");
  }

  return descriptions.length > 0 ? descriptions.join(" ") : `"${query}"`;
}

type LifeOpsGmailReadResultLike = {
  query: string | null;
  message: LifeOpsGmailMessageSummary;
  bodyText: string;
};

export function formatEmailSearch(feed: LifeOpsGmailSearchFeed): string {
  const queryDescription = describeEmailSearchQuery(feed.query);
  if (feed.messages.length === 0) {
    return `No email matched ${queryDescription}.`;
  }
  const lines = [
    `Found ${feed.summary.totalCount} email${feed.summary.totalCount === 1 ? "" : "s"} for ${queryDescription}.`,
  ];
  for (const message of feed.messages.slice(0, 8)) {
    const badges: string[] = [];
    if (message.isImportant) {
      badges.push("important");
    }
    if (message.likelyReplyNeeded) {
      badges.push("reply needed");
    }
    const badgeText = badges.length > 0 ? ` [${badges.join(", ")}]` : "";
    const sender = formatEmailSender(message.from, message.fromEmail);
    lines.push(
      `- **${message.subject}**${badgeText} from ${sender} · ${formatRelativeTime(message.receivedAt)}`,
    );
    if (message.snippet) {
      lines.push(`  ${truncateForPreview(message.snippet, 120)}`);
    }
  }
  return lines.join("\n");
}

export function formatEmailRead(result: LifeOpsGmailReadResultLike): string {
  const from = formatEmailSender(result.message.from, result.message.fromEmail);
  const bodyText = result.bodyText.trim();
  const maxChars = 2_500;
  const truncated = bodyText.length > maxChars;
  const preview = truncated
    ? `${bodyText.slice(0, maxChars).trimEnd()}\n\n[truncated]`
    : bodyText;
  const lines = [
    `**${result.message.subject}** from ${from} · ${formatRelativeTime(result.message.receivedAt)}`,
  ];
  if (result.query) {
    lines.push(`Resolved from ${describeEmailSearchQuery(result.query)}.`);
  }
  if (preview.length > 0) {
    lines.push(preview);
  } else if (result.message.snippet) {
    lines.push(
      `No readable body was available. Snippet: ${result.message.snippet}`,
    );
  } else {
    lines.push("No readable body was available for that email.");
  }
  return lines.join("\n\n");
}

export function formatGmailReplyDraft(draft: LifeOpsGmailReplyDraft): string {
  const lines = [`Drafted reply for **${draft.subject}**.`];
  if (draft.to.length > 0) {
    lines.push(`To: ${draft.to.join(", ")}`);
  }
  if (draft.cc.length > 0) {
    lines.push(`Cc: ${draft.cc.join(", ")}`);
  }
  lines.push("Preview:");
  for (const line of draft.previewLines.slice(0, 5)) {
    lines.push(`- ${line}`);
  }
  lines.push(
    draft.sendAllowed
      ? "Send is allowed, but still requires explicit confirmation."
      : "Send is not allowed with the current Google grant.",
  );
  return lines.join("\n");
}

export function formatGmailBatchReplyDrafts(
  batch: LifeOpsGmailBatchReplyDraftsFeed,
): string {
  if (batch.drafts.length === 0) {
    return "No Gmail reply drafts were created.";
  }
  const lines = [
    `Drafted ${batch.summary.totalCount} Gmail repl${batch.summary.totalCount === 1 ? "y" : "ies"}.`,
  ];
  for (const draft of batch.drafts.slice(0, 5)) {
    lines.push(
      `- **${draft.subject}** → ${draft.to.join(", ") || "reply recipients"}`,
    );
  }
  if (batch.summary.requiresConfirmationCount > 0) {
    lines.push(
      `${batch.summary.requiresConfirmationCount} draft${batch.summary.requiresConfirmationCount === 1 ? "" : "s"} still require send confirmation.`,
    );
  }
  return lines.join("\n");
}

export function formatOverview(overview: LifeOpsOverview): string {
  const summary = overview.owner.summary;
  const lines = [
    "Life Ops overview:",
    `- ${summary.activeOccurrenceCount} active items (${summary.overdueOccurrenceCount} overdue, ${summary.snoozedOccurrenceCount} snoozed)`,
    `- ${summary.activeGoalCount} active goals`,
    `- ${summary.activeReminderCount} pending reminders`,
  ];
  if (overview.schedule) {
    const schedule = overview.schedule;
    const isAsleepState =
      schedule.circadianState === "sleeping" ||
      schedule.circadianState === "napping";
    const sleepLine = isAsleepState
      ? schedule.currentSleepStartedAt
        ? `Likely asleep since ${schedule.currentSleepStartedAt}`
        : "Likely asleep now"
      : schedule.lastSleepEndedAt
        ? `Last wake ${schedule.lastSleepEndedAt}${schedule.lastSleepDurationMinutes ? ` after ${schedule.lastSleepDurationMinutes} minutes asleep` : ""}`
        : `Sleep status ${schedule.sleepStatus}`;
    lines.push(`- Circadian state: ${schedule.circadianState}`);
    if (schedule.relativeTime.minutesSinceWake !== null) {
      const bedtimeClause =
        schedule.relativeTime.minutesUntilBedtimeTarget !== null
          ? `; bedtime in ${schedule.relativeTime.minutesUntilBedtimeTarget} minutes`
          : schedule.relativeTime.minutesSinceBedtimeTarget !== null
            ? `; bedtime was ${schedule.relativeTime.minutesSinceBedtimeTarget} minutes ago`
            : "";
      lines.push(
        `- Relative time: woke ${schedule.relativeTime.minutesSinceWake} minutes ago${bedtimeClause}`,
      );
    } else if (schedule.relativeTime.minutesUntilBedtimeTarget !== null) {
      lines.push(
        `- Relative time: bedtime in ${schedule.relativeTime.minutesUntilBedtimeTarget} minutes`,
      );
    } else if (schedule.relativeTime.minutesSinceBedtimeTarget !== null) {
      lines.push(
        `- Relative time: bedtime was ${schedule.relativeTime.minutesSinceBedtimeTarget} minutes ago`,
      );
    }
    lines.push(`- ${sleepLine}`);
    if (schedule.nextMealLabel && schedule.nextMealWindowStartAt) {
      lines.push(
        `- Next ${schedule.nextMealLabel} window starts ${schedule.nextMealWindowStartAt} (${Math.round(schedule.nextMealConfidence * 100)}% confidence)`,
      );
    } else if (schedule.lastMealAt) {
      lines.push(`- Last inferred meal ${schedule.lastMealAt}`);
    }
  }
  if (overview.owner.occurrences.length > 0) {
    lines.push("\nCurrent items:");
    for (const occurrence of overview.owner.occurrences.slice(0, 5)) {
      const state =
        occurrence.state !== "visible" ? ` (${occurrence.state})` : "";
      lines.push(`- ${occurrence.title}${state}`);
    }
  }
  if (overview.owner.goals.length > 0) {
    lines.push("\nActive goals:");
    for (const goal of overview.owner.goals.slice(0, 3)) {
      lines.push(`- ${goal.title} (${goal.status})`);
    }
  }
  return lines.join("\n");
}

const REMAINING_TODAY_QUERY_RE =
  /\b(?:what'?s still left(?: for today)?|what do i still need to do today|anything else .*?(?:get done|finish).*?today|what life ops tasks are still left for today|what remains today|what(?:'s| is) left today)\b/i;

function looksLikeRemainingTodayOverviewQuery(query: string): boolean {
  return REMAINING_TODAY_QUERY_RE.test(query);
}

function overviewAnchorIso(occurrence: LifeOpsOccurrenceView): string {
  return (
    occurrence.snoozedUntil ??
    occurrence.dueAt ??
    occurrence.scheduledAt ??
    occurrence.relevanceStartAt
  );
}

function isRelevantToToday(
  occurrence: LifeOpsOccurrenceView,
  now: Date,
): boolean {
  const timeZone =
    typeof occurrence.timezone === "string" && occurrence.timezone.trim()
      ? occurrence.timezone.trim()
      : "UTC";
  const anchor = new Date(overviewAnchorIso(occurrence));
  if (!Number.isFinite(anchor.getTime())) {
    return true;
  }
  const todayKey = getLocalDateKey(getZonedDateParts(now, timeZone));
  const anchorKey = getLocalDateKey(getZonedDateParts(anchor, timeZone));
  return anchorKey <= todayKey;
}

type RemainingTodayGroup = {
  definitionId: string;
  title: string;
  count: number;
  earliestAnchorMs: number;
  windows: string[];
};

function normalizeRemainingTodayWindowLabel(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function buildRemainingTodayGroups(
  occurrences: LifeOpsOccurrenceView[],
  now: Date,
): RemainingTodayGroup[] {
  const groups = new Map<string, RemainingTodayGroup>();

  for (const occurrence of occurrences) {
    if (!isRelevantToToday(occurrence, now)) {
      continue;
    }

    const key = `${occurrence.definitionId}:${occurrence.title}`;
    const anchorMs = Date.parse(overviewAnchorIso(occurrence));
    const windowLabel = normalizeRemainingTodayWindowLabel(
      occurrence.windowName,
    );
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (Number.isFinite(anchorMs) && anchorMs < existing.earliestAnchorMs) {
        existing.earliestAnchorMs = anchorMs;
      }
      if (windowLabel && !existing.windows.includes(windowLabel)) {
        existing.windows.push(windowLabel);
      }
      continue;
    }

    groups.set(key, {
      definitionId: occurrence.definitionId,
      title: occurrence.title,
      count: 1,
      earliestAnchorMs: Number.isFinite(anchorMs)
        ? anchorMs
        : Number.MAX_SAFE_INTEGER,
      windows: windowLabel ? [windowLabel] : [],
    });
  }

  return [...groups.values()].sort(
    (left, right) => left.earliestAnchorMs - right.earliestAnchorMs,
  );
}

function formatRemainingTodayLabel(group: RemainingTodayGroup): string {
  if (group.windows.length === 1) {
    return `${group.title} ${group.windows[0]}`;
  }
  if (group.windows.length > 1) {
    return `${group.title} (${formatHumanList(group.windows)})`;
  }
  if (group.count > 1) {
    return `${group.title} (${group.count} times)`;
  }
  return group.title;
}

function formatHumanList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] || "";
  return new Intl.ListFormat("en", {
    style: "long",
    type: "conjunction",
  }).format(items);
}

export function formatOverviewForQuery(
  overview: LifeOpsOverview,
  query: string,
  now = new Date(),
): string {
  if (!looksLikeRemainingTodayOverviewQuery(query)) {
    return formatOverview(overview);
  }
  const remainingTodayGroups = buildRemainingTodayGroups(
    overview.owner.occurrences,
    now,
  );
  if (remainingTodayGroups.length === 0) {
    return "You don't have any LifeOps tasks left for today.";
  }
  const labels = remainingTodayGroups
    .slice(0, 5)
    .map((group) => formatRemainingTodayLabel(group));
  const noun = remainingTodayGroups.length === 1 ? "task" : "tasks";
  if (remainingTodayGroups.length <= labels.length) {
    return `You have ${remainingTodayGroups.length} LifeOps ${noun} left for today: ${formatHumanList(labels)}.`;
  }
  return `You have ${remainingTodayGroups.length} LifeOps ${noun} left for today. Next up: ${formatHumanList(labels)}, plus ${remainingTodayGroups.length - labels.length} more.`;
}

export type GoogleCapabilityStatus = {
  status: LifeOpsGoogleConnectorStatus | null;
  connected: boolean;
  hasCalendarRead: boolean;
  hasCalendarWrite: boolean;
  hasGmailTriage: boolean;
  hasGmailSend: boolean;
  hasGmailManage: boolean;
};

export async function getGoogleCapabilityStatus(
  service: LifeOpsService,
): Promise<GoogleCapabilityStatus> {
  let status: LifeOpsGoogleConnectorStatus;
  try {
    status = await service.getGoogleConnectorStatus(INTERNAL_URL);
  } catch {
    return {
      status: null,
      connected: false,
      hasCalendarRead: false,
      hasCalendarWrite: false,
      hasGmailTriage: false,
      hasGmailSend: false,
      hasGmailManage: false,
    };
  }
  const capabilities = new Set(status.grantedCapabilities ?? []);
  return {
    status,
    connected: status.connected,
    hasCalendarRead:
      capabilities.has("google.calendar.read") ||
      capabilities.has("google.calendar.write"),
    hasCalendarWrite: capabilities.has("google.calendar.write"),
    hasGmailTriage: capabilities.has("google.gmail.triage"),
    hasGmailSend: capabilities.has("google.gmail.send"),
    hasGmailManage: capabilities.has("google.gmail.manage"),
  };
}

export function calendarReadUnavailableMessage(
  google: GoogleCapabilityStatus,
): string {
  return google.connected
    ? "Google Calendar access is limited. Reconnect Google in LifeOps settings to grant calendar access."
    : "Google Calendar is not connected. Connect Google in LifeOps settings to use calendar actions.";
}

export function calendarWriteUnavailableMessage(
  google: GoogleCapabilityStatus,
): string {
  return google.connected
    ? "Google Calendar write access is not granted. Reconnect Google in LifeOps settings to allow calendar event creation."
    : "Google Calendar is not connected. Connect Google in LifeOps settings before creating calendar events.";
}

export function gmailReadUnavailableMessage(
  google: GoogleCapabilityStatus,
): string {
  return google.connected
    ? "Gmail access is limited. Reconnect Google in LifeOps settings to grant Gmail triage and search access."
    : "Gmail is not connected. Connect Google in LifeOps settings to use Gmail actions.";
}

export function gmailSendUnavailableMessage(
  google: GoogleCapabilityStatus,
): string {
  return google.connected
    ? "Gmail send access is not granted. Reconnect Google in LifeOps settings to allow email sending."
    : "Gmail is not connected. Connect Google in LifeOps settings before sending email.";
}
