import {
  type ClientCalendarDayObservation,
  parseClientCalendarDayObservation,
} from "@elizaos/contracts/client-turn-observation";
import { addDaysToLocalDate, getZonedDateParts } from "../internal/time.ts";

/** The committed Calendar view, without event contents or provider credentials. */
export interface CalendarDayObservationState {
  dayOffset: unknown;
  mode: "day" | "month";
  selection: "none" | "event" | "editor";
  source: "canonical" | "other";
  status: string;
  mutating: boolean;
  ownerKey: string | null;
}
export interface CalendarObservationHost {
  /** The host owns screen, lock, overlay and page-lifetime visibility. */
  visible: boolean;
  ownerCurrent: boolean;
  currentOwnerKey: string | null;
}
/** Ready current-owner day-view context only. This never grants Calendar read or write authority. */
export function calendarDayObservation(
  state: CalendarDayObservationState,
  host: CalendarObservationHost,
  timeZone: string,
  now = Date.now(),
): ClientCalendarDayObservation | undefined {
  if (
    !host.visible ||
    !host.ownerCurrent ||
    !state.ownerKey ||
    state.ownerKey !== host.currentOwnerKey ||
    state.status !== "ready" ||
    state.mutating ||
    state.mode !== "day" ||
    state.selection !== "none" ||
    state.source !== "canonical" ||
    !Number.isSafeInteger(state.dayOffset) ||
    !Number.isFinite(now)
  )
    return;
  try {
    const day = addDaysToLocalDate(
      getZonedDateParts(new Date(now), timeZone),
      state.dayOffset as number,
    );
    return parseClientCalendarDayObservation({
      date: `${String(day.year).padStart(4, "0")}-${String(day.month).padStart(2, "0")}-${String(day.day).padStart(2, "0")}`,
      timeZone,
    });
  } catch {
    return;
  }
}
