import type { IAgentRuntime } from "@elizaos/core";
import type {
  CreateLifeOpsDefinitionRequest,
  LifeOpsActiveReminderView,
  LifeOpsCalendarEvent,
  LifeOpsOccurrenceView,
  LifeOpsReminderPlan,
  LifeOpsReminderStep,
  LifeOpsReminderUrgency,
  LifeOpsTaskDefinition,
  LifeOpsWindowPolicy,
  SnoozeLifeOpsOccurrenceRequest,
  UpdateLifeOpsDefinitionRequest,
} from "../contracts/index.js";
import { LIFEOPS_REMINDER_CHANNELS } from "../contracts/index.js";
import { DEFAULT_REMINDER_STEPS, isValidTimeZone } from "./defaults.js";
import { DAY_MINUTES, MAX_OVERVIEW_OCCURRENCES } from "./service-constants.js";
import {
  fail,
  normalizeEnumValue,
  normalizeFiniteNumber,
  requireNonEmptyString,
} from "./service-normalize.js";
import { normalizeQuietHoursInput } from "./service-normalize-connector.js";
import type { ReminderAttemptLifecycle } from "./service-types.js";
import {
  addDaysToLocalDate,
  addMinutes,
  buildUtcDateFromLocalParts,
  getZonedDateParts,
  type ZonedDateParts,
} from "./time.js";

// ---------------------------------------------------------------------------
// Record / metadata utilities (lines 810-900)
// ---------------------------------------------------------------------------

export function clearGoogleGrantAuthFailureMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...metadata };
  delete next.authState;
  delete next.lastAuthError;
  delete next.lastAuthErrorAt;
  return next;
}

export function googleGrantHasAuthFailureMetadata(
  metadata: Record<string, unknown>,
): boolean {
  return (
    metadata.authState !== undefined ||
    metadata.lastAuthError !== undefined ||
    metadata.lastAuthErrorAt !== undefined
  );
}

export function normalizedStringSet(values: readonly string[]): string[] {
  return [
    ...new Set(values.map((value) => value.trim()).filter(Boolean)),
  ].sort();
}

export function sameNormalizedStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const leftValues = normalizedStringSet(left);
  const rightValues = normalizedStringSet(right);
  if (leftValues.length !== rightValues.length) {
    return false;
  }
  return leftValues.every((value, index) => value === rightValues[index]);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function cloneRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return { ...value };
}

export function requireRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(400, `${field} must be an object`);
  }
  return { ...value };
}

export function normalizeOptionalRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  return requireRecord(value, field);
}

export function normalizeNullableRecord(
  value: unknown,
  field: string,
): Record<string, unknown> | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireRecord(value, field);
}

export function mergeMetadata(
  current: Record<string, unknown>,
  updates?: Record<string, unknown>,
): Record<string, unknown> {
  const merged = {
    ...current,
    ...cloneRecord(updates),
  };
  if (
    typeof merged.privacyClass !== "string" ||
    merged.privacyClass.trim().length === 0
  ) {
    merged.privacyClass = "private";
  }
  if (merged.privacyClass === "private") {
    merged.publicContextBlocked = true;
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Reminder plan and scheduling helpers (lines 3520-4099)
// ---------------------------------------------------------------------------

export function normalizeReminderSteps(value: unknown): LifeOpsReminderStep[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(400, "reminderPlan.steps must contain at least one step");
  }
  const steps = value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") {
      fail(400, `reminderPlan.steps[${index}] must be an object`);
    }
    const stepRecord = candidate as Record<string, unknown>;
    const channel = normalizeEnumValue(
      stepRecord.channel,
      `reminderPlan.steps[${index}].channel`,
      LIFEOPS_REMINDER_CHANNELS,
    );
    const offsetMinutes = Math.trunc(
      normalizeFiniteNumber(
        stepRecord.offsetMinutes,
        `reminderPlan.steps[${index}].offsetMinutes`,
      ),
    );
    if (offsetMinutes < 0) {
      fail(
        400,
        `reminderPlan.steps[${index}].offsetMinutes must be zero or greater`,
      );
    }
    const label = requireNonEmptyString(
      stepRecord.label,
      `reminderPlan.steps[${index}].label`,
    );
    return {
      channel,
      offsetMinutes,
      label,
    } satisfies LifeOpsReminderStep;
  });
  steps.sort((left, right) => left.offsetMinutes - right.offsetMinutes);
  return steps;
}

export function normalizeReminderPlanDraft(
  reminderPlan:
    | CreateLifeOpsDefinitionRequest["reminderPlan"]
    | UpdateLifeOpsDefinitionRequest["reminderPlan"]
    | undefined,
  mode: "create" | "update",
):
  | {
      steps: LifeOpsReminderStep[];
      mutePolicy: Record<string, unknown>;
      quietHours: Record<string, unknown>;
    }
  | null
  | undefined {
  if (reminderPlan === undefined) {
    return mode === "create"
      ? {
          steps: DEFAULT_REMINDER_STEPS.map((step) => ({ ...step })),
          mutePolicy: {},
          quietHours: {},
        }
      : undefined;
  }
  if (reminderPlan === null) return null;
  return {
    steps: normalizeReminderSteps(reminderPlan.steps),
    mutePolicy: cloneRecord(reminderPlan.mutePolicy),
    quietHours: normalizeQuietHoursInput(
      reminderPlan.quietHours,
      "reminderPlan.quietHours",
    ),
  };
}

export function buildWindowStartDate(
  timeZone: string,
  dateOnly: Pick<ZonedDateParts, "year" | "month" | "day">,
  startMinute: number,
): Date {
  const dayOffset = Math.floor(startMinute / DAY_MINUTES);
  const minuteOfDay = startMinute % DAY_MINUTES;
  const localDate = addDaysToLocalDate(dateOnly, dayOffset);
  return buildUtcDateFromLocalParts(timeZone, {
    ...localDate,
    hour: Math.floor(minuteOfDay / 60),
    minute: minuteOfDay % 60,
    second: 0,
  });
}

export function resolveUpcomingWindowStart(
  timeZone: string,
  windowPolicy: LifeOpsWindowPolicy,
  baseDate: Pick<ZonedDateParts, "year" | "month" | "day">,
  candidateNames: string[],
  fallbackMinute: number,
  notBefore: Date,
): Date {
  const matchingWindows = windowPolicy.windows
    .filter((window) => candidateNames.includes(window.name))
    .sort((left, right) => left.startMinute - right.startMinute);
  const candidateMinutes =
    matchingWindows.length > 0
      ? matchingWindows.map((window) => window.startMinute)
      : [fallbackMinute];
  for (let dayDelta = 0; dayDelta <= 2; dayDelta += 1) {
    const dateOnly = addDaysToLocalDate(baseDate, dayDelta);
    for (const minuteOfDay of candidateMinutes) {
      const candidate = buildWindowStartDate(timeZone, dateOnly, minuteOfDay);
      if (candidate.getTime() > notBefore.getTime()) {
        return candidate;
      }
    }
  }
  return buildWindowStartDate(
    timeZone,
    addDaysToLocalDate(baseDate, 1),
    candidateMinutes[0] ?? fallbackMinute,
  );
}

export function computeSnoozedUntil(
  definition: LifeOpsTaskDefinition,
  request: SnoozeLifeOpsOccurrenceRequest,
  now: Date,
): Date {
  if (request.preset) {
    const localNow = getZonedDateParts(now, definition.timezone);
    const today = {
      year: localNow.year,
      month: localNow.month,
      day: localNow.day,
    };
    switch (request.preset) {
      case "15m":
        return addMinutes(now, 15);
      case "30m":
        return addMinutes(now, 30);
      case "1h":
        return addMinutes(now, 60);
      case "tonight":
        return resolveUpcomingWindowStart(
          definition.timezone,
          definition.windowPolicy,
          today,
          ["evening", "night"],
          20 * 60,
          now,
        );
      case "tomorrow_morning": {
        const tomorrow = addDaysToLocalDate(today, 1);
        return resolveUpcomingWindowStart(
          definition.timezone,
          definition.windowPolicy,
          tomorrow,
          ["morning"],
          8 * 60,
          new Date(now.getTime() - 1),
        );
      }
      default:
        fail(400, "preset is not supported");
    }
  }
  const minutes = request.minutes ?? 30;
  const normalizedMinutes = Math.trunc(
    normalizeFiniteNumber(minutes, "minutes"),
  );
  if (normalizedMinutes <= 0) {
    fail(400, "minutes must be greater than 0");
  }
  return addMinutes(now, normalizedMinutes);
}

export function sortOverviewOccurrences(
  occurrences: LifeOpsOccurrenceView[],
): LifeOpsOccurrenceView[] {
  return [...occurrences].sort((left, right) => {
    const leftStart = new Date(left.relevanceStartAt).getTime();
    const rightStart = new Date(right.relevanceStartAt).getTime();
    if (leftStart !== rightStart) {
      return leftStart - rightStart;
    }
    if (left.priority !== right.priority) {
      return left.priority - right.priority;
    }
    return left.title.localeCompare(right.title);
  });
}

export function selectOverviewOccurrences(
  occurrences: LifeOpsOccurrenceView[],
): LifeOpsOccurrenceView[] {
  const visible = sortOverviewOccurrences(
    occurrences.filter(
      (occurrence) =>
        occurrence.state === "visible" || occurrence.state === "snoozed",
    ),
  );
  const pending = sortOverviewOccurrences(
    occurrences.filter((occurrence) => occurrence.state === "pending"),
  );
  const next: LifeOpsOccurrenceView[] = [];
  for (const occurrence of visible) {
    if (next.length >= MAX_OVERVIEW_OCCURRENCES) break;
    next.push(occurrence);
  }
  for (const occurrence of pending) {
    if (next.length >= MAX_OVERVIEW_OCCURRENCES) break;
    next.push(occurrence);
  }
  return next;
}

export function buildActiveReminders(
  occurrences: LifeOpsOccurrenceView[],
  plansByDefinitionId: Map<string, LifeOpsReminderPlan>,
  now: Date,
): LifeOpsActiveReminderView[] {
  const reminders: LifeOpsActiveReminderView[] = [];
  for (const occurrence of occurrences) {
    const plan = plansByDefinitionId.get(occurrence.definitionId);
    if (!plan) continue;
    if (
      occurrence.state === "completed" ||
      occurrence.state === "skipped" ||
      occurrence.state === "expired" ||
      occurrence.state === "muted"
    ) {
      continue;
    }
    const anchorIso = occurrence.snoozedUntil ?? occurrence.relevanceStartAt;
    const anchorDate = new Date(anchorIso);
    for (const [stepIndex, step] of plan.steps.entries()) {
      const scheduledFor = addMinutes(anchorDate, step.offsetMinutes);
      if (scheduledFor.getTime() > now.getTime()) {
        continue;
      }
      reminders.push({
        domain: occurrence.domain,
        subjectType: occurrence.subjectType,
        subjectId: occurrence.subjectId,
        ownerType: "occurrence",
        ownerId: occurrence.id,
        occurrenceId: occurrence.id,
        definitionId: occurrence.definitionId,
        eventId: null,
        title: occurrence.title,
        channel: step.channel,
        stepIndex,
        stepLabel: step.label,
        scheduledFor: scheduledFor.toISOString(),
        dueAt: occurrence.dueAt,
        state: occurrence.state,
        metadata: occurrence.metadata,
        htmlLink: null,
        eventStartAt: null,
      });
    }
  }
  reminders.sort(
    (left, right) =>
      new Date(left.scheduledFor).getTime() -
      new Date(right.scheduledFor).getTime(),
  );
  return reminders;
}

export function buildActiveCalendarEventReminders(
  events: LifeOpsCalendarEvent[],
  plansByEventId: Map<string, LifeOpsReminderPlan>,
  ownerEntityId: string,
  now: Date,
): LifeOpsActiveReminderView[] {
  const reminders: LifeOpsActiveReminderView[] = [];
  for (const event of events) {
    const plan = plansByEventId.get(event.id);
    if (!plan) continue;
    if (event.status === "cancelled") {
      continue;
    }
    const startAt = new Date(event.startAt);
    const endAt = new Date(event.endAt);
    if (endAt.getTime() <= now.getTime()) {
      continue;
    }
    for (const [stepIndex, step] of plan.steps.entries()) {
      const scheduledFor = addMinutes(startAt, -step.offsetMinutes);
      if (scheduledFor.getTime() > now.getTime()) {
        continue;
      }
      reminders.push({
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: ownerEntityId,
        ownerType: "calendar_event",
        ownerId: event.id,
        occurrenceId: null,
        definitionId: null,
        eventId: event.id,
        title: event.title,
        channel: step.channel,
        stepIndex,
        stepLabel: step.label,
        scheduledFor: scheduledFor.toISOString(),
        dueAt: event.startAt,
        state: "upcoming",
        metadata: event.metadata,
        htmlLink: event.htmlLink,
        eventStartAt: event.startAt,
      });
    }
  }
  reminders.sort(
    (left, right) =>
      new Date(left.scheduledFor).getTime() -
      new Date(right.scheduledFor).getTime(),
  );
  return reminders;
}

export function parseQuietHoursPolicy(
  value: LifeOpsReminderPlan["quietHours"],
): {
  timezone: string;
  startMinute: number;
  endMinute: number;
  channels: Set<string>;
} | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.timezone !== "string" ||
    typeof value.startMinute !== "number" ||
    typeof value.endMinute !== "number"
  ) {
    return null;
  }
  const timezone = value.timezone.trim();
  if (!isValidTimeZone(timezone)) {
    return null;
  }
  const channels = Array.isArray(value.channels)
    ? new Set(
        value.channels.filter(
          (entry): entry is string => typeof entry === "string",
        ),
      )
    : new Set<string>();
  const startMinute = Math.trunc(value.startMinute);
  const endMinute = Math.trunc(value.endMinute);
  if (
    startMinute < 0 ||
    startMinute >= DAY_MINUTES ||
    endMinute < 0 ||
    endMinute >= DAY_MINUTES
  ) {
    return null;
  }
  return {
    timezone,
    startMinute,
    endMinute,
    channels,
  };
}

export function isWithinQuietHours(args: {
  now: Date;
  quietHours: LifeOpsReminderPlan["quietHours"];
  channel: LifeOpsReminderStep["channel"];
}): boolean {
  const quietHours = parseQuietHoursPolicy(args.quietHours);
  if (!quietHours) {
    return false;
  }
  if (quietHours.channels.size > 0 && !quietHours.channels.has(args.channel)) {
    return false;
  }
  const parts = getZonedDateParts(args.now, quietHours.timezone);
  const minuteOfDay = parts.hour * 60 + parts.minute;
  if (quietHours.startMinute === quietHours.endMinute) {
    return false;
  }
  if (quietHours.startMinute < quietHours.endMinute) {
    return (
      minuteOfDay >= quietHours.startMinute &&
      minuteOfDay < quietHours.endMinute
    );
  }
  return (
    minuteOfDay >= quietHours.startMinute || minuteOfDay < quietHours.endMinute
  );
}

export function isReminderChannelAllowedForUrgency(
  channel: LifeOpsReminderStep["channel"],
  urgency: LifeOpsReminderUrgency,
): boolean {
  if (channel === "in_app") {
    return true;
  }
  if (channel === "voice") {
    return urgency === "high" || urgency === "critical";
  }
  if (channel === "sms") {
    return urgency !== "low";
  }
  return urgency === "medium" || urgency === "high" || urgency === "critical";
}

export function priorityToUrgency(priority: number): LifeOpsReminderUrgency {
  if (priority <= 1) return "critical";
  if (priority === 2) return "high";
  if (priority === 3) return "medium";
  return "low";
}

export function buildReminderBody(args: {
  title: string;
  scheduledFor: string;
  channel: LifeOpsReminderStep["channel"];
  lifecycle?: ReminderAttemptLifecycle;
  dueAt?: string | null;
  nearbyReminderTitles?: string[];
}): string {
  const focus =
    args.lifecycle === "escalation"
      ? `${args.title} still needs your attention`
      : `${args.title} is up`;
  const reminderAt = args.dueAt ?? args.scheduledFor;
  const reminderDate = new Date(reminderAt);
  const timePhrase = Number.isNaN(reminderDate.getTime())
    ? ""
    : (() => {
        const deltaMinutes = Math.round(
          (reminderDate.getTime() - Date.now()) / 60_000,
        );
        if (Math.abs(deltaMinutes) <= 10) {
          return " now";
        }
        const sameDay =
          reminderDate.toDateString() === new Date().toDateString();
        const formatted = reminderDate.toLocaleTimeString([], {
          hour: "numeric",
          minute: "2-digit",
        });
        return sameDay
          ? ` at ${formatted}`
          : ` on ${reminderDate.toLocaleString()}`;
      })();
  const nearby =
    Array.isArray(args.nearbyReminderTitles) &&
    args.nearbyReminderTitles.length > 0
      ? ` ${formatNearbyReminderTitlesForFallback(args.nearbyReminderTitles)}`
      : "";
  if (args.channel === "voice") {
    return `${focus}${timePhrase}.${nearby}`.trim();
  }
  return `${focus}${timePhrase}.${nearby}`.trim();
}

export function normalizeCharacterLines(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

export function buildReminderVoiceContext(runtime: IAgentRuntime): string {
  const character = runtime.character;
  if (!character || typeof character !== "object") {
    return "";
  }
  const sections: string[] = [];
  if (
    typeof character.system === "string" &&
    character.system.trim().length > 0
  ) {
    sections.push(`System:\n${character.system.trim()}`);
  }
  const bioLines = normalizeCharacterLines(character.bio);
  if (bioLines.length > 0) {
    sections.push(`Bio:\n${bioLines.map((line) => `- ${line}`).join("\n")}`);
  }
  const styleLines = [
    ...normalizeCharacterLines(character.style?.all),
    ...normalizeCharacterLines(character.style?.chat),
  ];
  if (styleLines.length > 0) {
    sections.push(
      `Style:\n${styleLines.map((line) => `- ${line}`).join("\n")}`,
    );
  }
  return sections.join("\n\n");
}

export function formatReminderConversationLine(args: {
  agentId: string;
  agentName: string;
  ownerEntityId: string;
  memory: {
    entityId?: string;
    content?: { text?: string; type?: string };
  };
}): string | null {
  const text =
    typeof args.memory.content?.text === "string"
      ? args.memory.content.text.trim()
      : "";
  if (
    !text ||
    args.memory.content?.type === "action_result" ||
    text.startsWith("Reminder:") ||
    text.startsWith("Agent reminder:")
  ) {
    return null;
  }
  const speaker =
    args.memory.entityId === args.agentId
      ? args.agentName
      : args.memory.entityId === args.ownerEntityId
        ? "User"
        : "Other";
  return `${speaker}: ${text}`;
}

export function normalizeGeneratedReminderBody(value: string): string | null {
  return normalizeGeneratedLifeOpsAssistantText(value, [
    /^(?:follow[- ]?up reminder|reminder)\s*[:,-]\s*/i,
  ]);
}

export function normalizeGeneratedWorkflowBody(value: string): string | null {
  return normalizeGeneratedLifeOpsAssistantText(value, [
    /^(?:scheduled workflow|workflow)\s*[:,-]\s*/i,
  ]);
}

export function normalizeGeneratedLifeOpsAssistantText(
  value: string,
  stripPrefixes: RegExp[] = [],
): string | null {
  let cleaned = value
    .replace(/<think>[\s\S]*?<\/think>/gi, " ")
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const pattern of stripPrefixes) {
    cleaned = cleaned.replace(pattern, "").trim();
  }
  if (!cleaned) {
    return null;
  }
  return cleaned.length > 280
    ? `${cleaned.slice(0, 277).trimEnd()}...`
    : cleaned;
}

export function formatNearbyReminderTitlesForPrompt(titles: string[]): string {
  if (titles.length === 0) {
    return "None.";
  }
  return titles.map((title) => `- ${title}`).join("\n");
}

export function formatNearbyReminderTitlesForFallback(
  titles: string[],
): string {
  const unique = [...new Set(titles)].slice(0, 2);
  if (unique.length === 0) {
    return "";
  }
  if (unique.length === 1) {
    return `You also have ${unique[0]} coming up.`;
  }
  return `You also have ${unique[0]} and ${unique[1]} coming up.`;
}
