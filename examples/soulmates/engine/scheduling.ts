import { createLogger } from "./logger";
import type {
  Availability,
  DayOfWeek,
  LocationSuggestionProvider,
  MatchRecord,
  MeetingLocation,
  MeetingRecord,
  Persona,
} from "./types";
import { unique } from "./utils";

const logger = createLogger("scheduling");

const WEEKDAY_MAP: Record<string, DayOfWeek> = {
  Mon: "mon",
  Tue: "tue",
  Wed: "wed",
  Thu: "thu",
  Fri: "fri",
  Sat: "sat",
  Sun: "sun",
};

const getZonedParts = (
  date: Date,
  timeZone: string,
): Record<string, string> => {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const out: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      out[part.type] = part.value;
    }
  }
  return out;
};

const getTimeZoneOffsetMinutes = (date: Date, timeZone: string): number => {
  const parts = getZonedParts(date, timeZone);
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute);
  return (localAsUtc - date.getTime()) / 60000;
};

const dayKeyForDate = (date: Date, timeZone: string): DayOfWeek => {
  const parts = getZonedParts(date, timeZone);
  const shortDay = parts.weekday;
  return WEEKDAY_MAP[shortDay] ?? "mon";
};

const localMinutesForDate = (date: Date, timeZone: string): number => {
  const parts = getZonedParts(date, timeZone);
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return hour * 60 + minute;
};

const windowsByDay = (
  availability: Availability,
): Map<DayOfWeek, Availability["weekly"]> => {
  const byDay = new Map<DayOfWeek, Availability["weekly"]>();
  for (const window of availability.weekly) {
    const list = byDay.get(window.day) ?? [];
    list.push(window);
    byDay.set(window.day, list);
  }
  return byDay;
};

const pickTimeOfDay = (
  minutes: number,
): "morning" | "afternoon" | "evening" => {
  if (minutes < 12 * 60) {
    return "morning";
  }
  if (minutes < 17 * 60) {
    return "afternoon";
  }
  return "evening";
};

const findOverlapSlot = (
  availabilityA: Availability,
  availabilityB: Availability,
  now: string,
  minMinutes: number,
): { scheduledAt: string; startMinutes: number } | null => {
  if (availabilityA.timeZone !== availabilityB.timeZone) {
    return null;
  }
  const timeZone = availabilityA.timeZone;
  const byDayA = windowsByDay(availabilityA);
  const byDayB = windowsByDay(availabilityB);
  const nowDate = new Date(now);

  for (let offset = 0; offset < 7; offset += 1) {
    const candidateDate = new Date(nowDate);
    candidateDate.setUTCDate(nowDate.getUTCDate() + offset);
    const dayKey = dayKeyForDate(candidateDate, timeZone);
    const listA = byDayA.get(dayKey) ?? [];
    const listB = byDayB.get(dayKey) ?? [];
    if (listA.length === 0 || listB.length === 0) {
      continue;
    }
    const currentMinutes =
      offset === 0 ? localMinutesForDate(nowDate, timeZone) : 0;

    for (const windowA of listA) {
      for (const windowB of listB) {
        const start = Math.max(windowA.startMinutes, windowB.startMinutes);
        const end = Math.min(windowA.endMinutes, windowB.endMinutes);
        if (end - start < minMinutes) {
          continue;
        }
        if (start < currentMinutes + 15) {
          continue;
        }
        const parts = getZonedParts(candidateDate, timeZone);
        const year = Number(parts.year);
        const month = Number(parts.month);
        const day = Number(parts.day);
        const localMidnightUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
        const offsetMinutes = getTimeZoneOffsetMinutes(
          new Date(localMidnightUtc),
          timeZone,
        );
        const scheduledUtc =
          localMidnightUtc - offsetMinutes * 60000 + start * 60000;
        return {
          scheduledAt: new Date(scheduledUtc).toISOString(),
          startMinutes: start,
        };
      }
    }
  }
  return null;
};

const suggestLocation = async (
  personaA: Persona,
  personaB: Persona,
  startMinutes: number,
  provider?: LocationSuggestionProvider,
): Promise<MeetingLocation> => {
  const city =
    personaA.general.location.city === personaB.general.location.city
      ? personaA.general.location.city
      : personaA.general.location.city;
  const interests = unique([
    ...personaA.profile.interests,
    ...personaB.profile.interests,
  ]).slice(0, 6);
  if (provider) {
    const suggestions = await provider.suggest({
      city,
      interests,
      timeOfDay: pickTimeOfDay(startMinutes),
      limit: 3,
    });
    if (suggestions.length > 0) {
      return suggestions[0];
    }
  }
  return {
    name: "TBD",
    address: "TBD",
    city,
    notes: "Auto-proposed placeholder.",
  };
};

export const proposeMeetingRecord = async (
  match: MatchRecord,
  personaA: Persona,
  personaB: Persona,
  now: string,
  locationProvider: LocationSuggestionProvider | undefined,
  minAvailabilityMinutes: number,
  idFactory: () => string,
): Promise<MeetingRecord | null> => {
  logger.debug("Proposing meeting", {
    matchId: match.matchId,
    personaAId: personaA.id,
    personaBId: personaB.id,
    minAvailabilityMinutes,
  });

  const slot = findOverlapSlot(
    personaA.profile.availability,
    personaB.profile.availability,
    now,
    minAvailabilityMinutes,
  );
  if (!slot) {
    logger.debug("No availability overlap found", {
      matchId: match.matchId,
      personaAId: personaA.id,
      personaBId: personaB.id,
    });
    return null;
  }
  const location = await suggestLocation(
    personaA,
    personaB,
    slot.startMinutes,
    locationProvider,
  );

  logger.info("Meeting proposed", {
    matchId: match.matchId,
    scheduledAt: slot.scheduledAt,
    location: location.name,
  });

  return {
    meetingId: idFactory(),
    matchId: match.matchId,
    scheduledAt: slot.scheduledAt,
    location,
    status: "scheduled",
    rescheduleCount: 0,
  };
};
