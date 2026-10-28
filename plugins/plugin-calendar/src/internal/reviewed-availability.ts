/** The existing Calendar engine evaluates an approved, bounded device snapshot. */
import {
  type CalendarAvailabilityEvent,
  type CalendarAvailabilityPolicy,
  type CalendarAvailabilityProposal,
  evaluateCalendarAvailability,
} from "../service/availability.js";
import { calendarRangeFitsLocalDays } from "./time.js";
export interface ReviewedAvailabilityRequest {
  kind: "calendar_availability";
  subaction: "scan_today" | "scan_week" | "scan_event_proposal";
  range: { start: string; end: string };
  timeZone: string;
  proposal?: CalendarAvailabilityProposal;
  policy?: CalendarAvailabilityPolicy;
}
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid reviewed availability scope");
  return value as Record<string, unknown>;
};
export function validateReviewedAvailabilityRequest(
  value: unknown,
): ReviewedAvailabilityRequest {
  const v = object(value);
  if (
    Object.keys(v).some(
      (key) =>
        ![
          "kind",
          "subaction",
          "range",
          "timeZone",
          "proposal",
          "policy",
        ].includes(key),
    ) ||
    v.kind !== "calendar_availability" ||
    !["scan_today", "scan_week", "scan_event_proposal"].includes(
      String(v.subaction),
    ) ||
    typeof v.timeZone !== "string"
  )
    throw Error("Invalid reviewed availability scope");
  const range = object(v.range);
  if (
    Object.keys(range).length !== 2 ||
    typeof range.start !== "string" ||
    typeof range.end !== "string" ||
    !calendarRangeFitsLocalDays(range.start, range.end, v.timeZone)
  )
    throw Error("Invalid reviewed availability window");
  new Intl.DateTimeFormat("en-US", { timeZone: v.timeZone });
  if ((v.subaction === "scan_event_proposal") !== !!v.proposal)
    throw Error("Invalid reviewed availability proposal");
  const candidate = JSON.parse(
    JSON.stringify(v),
  ) as ReviewedAvailabilityRequest;
  const validated = evaluateCalendarAvailability({
    range: candidate.range,
    timeZone: candidate.timeZone,
    sources: [],
    ...(candidate.proposal ? { proposal: candidate.proposal } : {}),
    ...(candidate.policy ? { policy: candidate.policy } : {}),
  });
  return { ...candidate, range: validated.range };
}
export function evaluateReviewedAvailability(
  request: ReviewedAvailabilityRequest,
  value: unknown,
) {
  const spec = validateReviewedAvailabilityRequest(request),
    result = object(value),
    window = object(result.window);
  if (
    window.start !== spec.range.start ||
    window.end !== spec.range.end ||
    window.timeZone !== spec.timeZone
  )
    throw Error("Reviewed Calendar snapshot window changed");
  if (result.kind === "calendar_availability") {
    if (
      !Number.isInteger(result.calendarCount) ||
      Number(result.calendarCount) < 1 ||
      Number(result.calendarCount) > 16 ||
      !Array.isArray(result.busy)
    )
      throw Error("Invalid reviewed calendar set");
    const events: CalendarAvailabilityEvent[] = result.busy.map(
      (raw, index) => {
        const interval = object(raw);
        if (
          typeof interval.start !== "string" ||
          typeof interval.end !== "string" ||
          typeof interval.tentative !== "boolean"
        )
          throw Error("Invalid reviewed busy interval");
        return {
          id: "approved-busy-" + index,
          startISO: interval.start,
          endISO: interval.end,
          status: interval.tentative ? "tentative" : "confirmed",
        };
      },
    );
    return evaluateCalendarAvailability({
      range: spec.range,
      timeZone: spec.timeZone,
      sources: [
        {
          id: "reviewed-calendar-set",
          status: "fresh",
          visibility: "busy_only",
          events,
        },
      ],
      ...(spec.proposal ? { proposal: spec.proposal } : {}),
      ...(spec.policy ? { policy: spec.policy } : {}),
    });
  }
  const source = object(result.source);
  if (
    result.kind !== "calendar" ||
    !Array.isArray(result.events) ||
    typeof source.sourceId !== "string"
  )
    throw Error("Reviewed Calendar snapshot scope changed");
  const events: CalendarAvailabilityEvent[] = result.events.map((raw) => {
    const event = object(raw);
    if (
      event.calendarId !== source.sourceId ||
      typeof event.id !== "string" ||
      typeof event.start !== "string" ||
      typeof event.end !== "string" ||
      typeof event.allDay !== "boolean"
    )
      throw Error("Invalid reviewed Calendar interval");
    // Native all-day UTC bounds encode civil dates, just like the existing next-event formatter.
    return event.allDay
      ? {
          id: event.id,
          startDate: event.start.slice(0, 10),
          endDate: event.end.slice(0, 10),
          isAllDay: true,
          timeZone: spec.timeZone,
        }
      : { id: event.id, startISO: event.start, endISO: event.end };
  });
  return evaluateCalendarAvailability({
    range: spec.range,
    timeZone: spec.timeZone,
    sources: [
      {
        id: source.sourceId,
        status: result.complete === true ? "fresh" : "stale",
        visibility: "busy_only",
        events,
      },
    ],
    ...(spec.proposal ? { proposal: spec.proposal } : {}),
    ...(spec.policy ? { policy: spec.policy } : {}),
  });
}
export function formatReviewedAvailability(
  request: ReviewedAvailabilityRequest,
  value: unknown,
): string {
  const evaluation = evaluateReviewedAvailability(request, value),
    spec = validateReviewedAvailabilityRequest(request);
  const dateTime = (value: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: spec.timeZone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(new Date(value));
  const selected = object(value).kind === "calendar_availability";
  const scope = `Reviewed ${selected ? "selected-calendar" : "app-calendar"} window: ${dateTime(spec.range.start)} to ${dateTime(spec.range.end)}. `;
  if (evaluation.completeness !== "complete")
    return (
      scope +
      "The app-calendar snapshot is incomplete, so availability is not established. Other calendars were not checked."
    );
  const conflict = evaluation.conflicts[0];
  const answer =
    conflict && spec.proposal
      ? `That time overlaps a busy interval in the reviewed calendar snapshot (${dateTime(conflict.eventB.startISO)} to ${dateTime(conflict.eventB.endISO)}). `
      : "";
  return (
    scope +
    answer +
    evaluation.summary +
    " Other calendars were not checked; this does not establish availability across all calendars."
  );
}
