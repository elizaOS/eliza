/**
 * Presentational formatting for calendar events and feeds: renders event
 * date/times, the aggregated feed summary, and next-event context into the
 * human-readable strings the CALENDAR action returns to the owner.
 */
import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsNextCalendarEventContext,
} from "@elizaos/core/contracts/calendar";
import {
  addDaysToLocalDate,
  getTimeZoneOffsetMinutes,
  getZonedDateParts,
} from "./time.js";

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
    /**
     * Render in this zone instead of the event's own. Callers that list several
     * events side by side pass one zone so the times are comparable: a mixed
     * list read "friday aug 14 at 11am pdt and saturday aug 15 at 1pm utc"
     * (live capture), which asks the owner to do timezone math to compare two
     * of their own appointments.
     */
    timeZone?: string;
  },
): string {
  const start = new Date(event.startAt);
  const timeZone = options?.timeZone || event.timezone || undefined;
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

function formatEventTime(
  event: LifeOpsCalendarEvent,
  reference?: { asOf: Date; timeZone: string },
): string {
  if (event.isAllDay) {
    return "all day";
  }
  const start = new Date(event.startAt);
  const end = new Date(event.endAt);
  const timeZone = reference?.timeZone ?? (event.timezone || undefined);
  const currentYear = getCalendarYearForDisplay(
    reference?.asOf ?? new Date(),
    timeZone,
  );
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
    ...(reference &&
    getTimeZoneOffsetMinutes(start, reference.timeZone) !==
      getTimeZoneOffsetMinutes(end, reference.timeZone)
      ? { timeZoneName: "short" }
      : {}),
  });
  const endTime = formatCalendarDatePart(end, timeZone, {
    hour: "numeric",
    minute: "2-digit",
    ...(reference ? { timeZoneName: "short" } : {}),
  });
  return `${datePart}, ${startTime} – ${endTime}`;
}

function formatRelativeMinutes(minutes: number): string {
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
    return "No upcoming event was found in the checked calendar window.";
  }
  let reference: { asOf: Date; timeZone: string } | undefined;
  let relativeDay: string | undefined;
  if (
    context.timeReference &&
    typeof context.timeReference.asOf === "string" &&
    !context.event.isAllDay
  ) {
    const asOf = new Date(context.timeReference.asOf);
    const start = new Date(context.event.startAt);
    const timeZone = context.timeReference.timeZone;
    if (
      Number.isFinite(asOf.getTime()) &&
      Number.isFinite(start.getTime()) &&
      typeof timeZone === "string" &&
      timeZone.trim()
    ) {
      try {
        const current = getZonedDateParts(asOf, timeZone);
        const event = getZonedDateParts(start, timeZone);
        reference = { asOf, timeZone };
        for (const [offset, label] of [
          [-1, "yesterday"],
          [0, "today"],
          [1, "tomorrow"],
        ] as const) {
          const day = addDaysToLocalDate(current, offset);
          if (
            event.year === day.year &&
            event.month === day.month &&
            event.day === day.day
          ) {
            relativeDay = label;
            break;
          }
        }
      } catch {
        // error-policy:J3 malformed optional legacy references cannot support
        // a relative claim; retain the event's ordinary absolute display.
      }
    }
  }
  const lines = [
    `**Next event: ${context.event.title}** (${formatEventTime(context.event, reference)}${relativeDay ? `; ${relativeDay}` : ""})`,
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
    for (const mail of context.linkedMail) {
      const snippet = mail.snippet ? ` (${mail.snippet})` : "";
      lines.push(`- "${mail.subject}" from ${mail.from}${snippet}`);
    }
  }
  return lines.join("\n");
}
