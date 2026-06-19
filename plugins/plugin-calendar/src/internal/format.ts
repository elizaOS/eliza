import type {
  LifeOpsCalendarEvent,
  LifeOpsCalendarFeed,
  LifeOpsNextCalendarEventContext,
} from "@elizaos/shared";

function truncateForPreview(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength).trimEnd()}…`;
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
