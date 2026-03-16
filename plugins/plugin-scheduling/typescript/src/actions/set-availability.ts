/** Parses natural language availability ("weekdays 9-5", "monday afternoons") and saves to scheduling */

import type { Action, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { SchedulingService } from "../services/scheduling-service.js";
import type { AvailabilityWindow, DayOfWeek } from "../types.js";

const DAY_NAMES: Record<string, DayOfWeek> = {
  monday: "mon",
  mon: "mon",
  tuesday: "tue",
  tue: "tue",
  wednesday: "wed",
  wed: "wed",
  thursday: "thu",
  thu: "thu",
  friday: "fri",
  fri: "fri",
  saturday: "sat",
  sat: "sat",
  sunday: "sun",
  sun: "sun",
};

const TIME_PRESETS: Record<string, { start: number; end: number }> = {
  morning: { start: 540, end: 720 },
  afternoon: { start: 720, end: 1020 },
  evening: { start: 1020, end: 1260 },
  "business hours": { start: 540, end: 1020 },
  "work hours": { start: 540, end: 1020 },
};

const parseTimeToMinutes = (timeStr: string): number | null => {
  const normalized = timeStr.toLowerCase().trim();

  // Try "HH:MM" 24-hour format
  let match = /^(\d{1,2}):(\d{2})$/.exec(normalized);
  if (match) {
    const hours = Number.parseInt(match[1], 10);
    const minutes = Number.parseInt(match[2], 10);
    if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
      return hours * 60 + minutes;
    }
  }

  // Try "H:MMam/pm" or "HHam/pm" format
  match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(normalized);
  if (match) {
    let hours = Number.parseInt(match[1], 10);
    const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
    const isPm = match[3].toLowerCase() === "pm";

    if (hours === 12) {
      hours = isPm ? 12 : 0;
    } else if (isPm) {
      hours += 12;
    }

    if (hours >= 0 && hours < 24 && minutes >= 0 && minutes < 60) {
      return hours * 60 + minutes;
    }
  }

  return null;
};

const parseDays = (dayStr: string): DayOfWeek[] => {
  const normalized = dayStr.toLowerCase().trim();

  if (normalized === "weekday" || normalized === "weekdays") {
    return ["mon", "tue", "wed", "thu", "fri"];
  }

  if (normalized === "weekend" || normalized === "weekends") {
    return ["sat", "sun"];
  }

  if (normalized === "everyday" || normalized === "every day" || normalized === "daily") {
    return ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  }

  const day = DAY_NAMES[normalized];
  return day ? [day] : [];
};

const parseAvailabilityText = (
  text: string
): { windows: AvailabilityWindow[]; timeZone?: string } | null => {
  const normalized = text.toLowerCase();
  const windows: AvailabilityWindow[] = [];

  // Try to extract time zone
  let timeZone: string | undefined;
  const tzMatch =
    /(?:time\s*zone|tz|timezone)[\s:]*([A-Za-z_/]+)/i.exec(text) ||
    /(America\/[A-Za-z_]+|Europe\/[A-Za-z_]+|Asia\/[A-Za-z_]+|Pacific\/[A-Za-z_]+|UTC)/i.exec(text);
  if (tzMatch) {
    timeZone = tzMatch[1];
  }

  // Pattern: "weekdays 9am to 5pm" or "monday 10am-2pm"
  const dayTimePattern =
    /(weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|daily|every\s*day)(?:\s+(?:and\s+)?(?:weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun))*\s+(?:from\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:to|-)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi;

  let match: RegExpExecArray | null;
  while ((match = dayTimePattern.exec(normalized)) !== null) {
    const dayPart = match[1];
    const startTime = match[2];
    const endTime = match[3];

    const days = parseDays(dayPart);
    const startMinutes = parseTimeToMinutes(startTime);
    const endMinutes = parseTimeToMinutes(endTime);

    if (days.length > 0 && startMinutes !== null && endMinutes !== null) {
      for (const day of days) {
        windows.push({
          day,
          startMinutes,
          endMinutes,
        });
      }
    }
  }

  // Pattern: "weekday mornings" or "monday afternoons"
  const dayPresetPattern =
    /(weekdays?|weekends?|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|daily|every\s*day)\s+(morning|afternoon|evening|business\s*hours?|work\s*hours?)/gi;

  while ((match = dayPresetPattern.exec(normalized)) !== null) {
    const dayPart = match[1];
    const timePart = match[2].toLowerCase();

    const days = parseDays(dayPart);
    const timeRange = TIME_PRESETS[timePart] || TIME_PRESETS[timePart.replace(/s$/, "")];

    if (days.length > 0 && timeRange) {
      for (const day of days) {
        // Avoid duplicates
        const exists = windows.some(
          (w) =>
            w.day === day && w.startMinutes === timeRange.start && w.endMinutes === timeRange.end
        );
        if (!exists) {
          windows.push({
            day,
            startMinutes: timeRange.start,
            endMinutes: timeRange.end,
          });
        }
      }
    }
  }

  // Fallback: "I'm free mornings" (assume weekdays)
  if (windows.length === 0) {
    for (const [preset, range] of Object.entries(TIME_PRESETS)) {
      if (normalized.includes(preset)) {
        // Assume weekdays if no day specified
        for (const day of ["mon", "tue", "wed", "thu", "fri"] as DayOfWeek[]) {
          windows.push({
            day,
            startMinutes: range.start,
            endMinutes: range.end,
          });
        }
        break;
      }
    }
  }

  if (windows.length === 0) {
    return null;
  }

  return { windows, timeZone };
};

const formatTime = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const period = hours >= 12 ? "pm" : "am";
  const displayHours = hours > 12 ? hours - 12 : hours === 0 ? 12 : hours;
  return mins > 0
    ? `${displayHours}:${mins.toString().padStart(2, "0")}${period}`
    : `${displayHours}${period}`;
};

const formatDay = (day: DayOfWeek): string => {
  const names: Record<DayOfWeek, string> = {
    mon: "Monday",
    tue: "Tuesday",
    wed: "Wednesday",
    thu: "Thursday",
    fri: "Friday",
    sat: "Saturday",
    sun: "Sunday",
  };
  return names[day];
};

export const setAvailabilityAction: Action = {
  name: "SET_AVAILABILITY",
  similes: ["UPDATE_AVAILABILITY", "SET_SCHEDULE", "UPDATE_SCHEDULE", "SET_FREE_TIME", "WHEN_FREE"],
  description: "Set the user's availability for scheduling meetings",
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const text = message.content?.text?.toLowerCase() ?? "";
    return (
      text.includes("available") ||
      text.includes("availability") ||
      text.includes("free on") ||
      text.includes("i'm free") ||
      text.includes("can meet") ||
      text.includes("my time") ||
      text.includes("morning") ||
      text.includes("afternoon") ||
      text.includes("evening")
    );
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ) => {
    const schedulingService = runtime.getService<SchedulingService>("SCHEDULING");
    if (!schedulingService) {
      await callback?.({
        text: "Scheduling service is not available. Please try again later.",
      });
      return { success: false };
    }

    const entityId = message.entityId;
    if (!entityId) {
      await callback?.({
        text: "I could not identify you. Please try again.",
      });
      return { success: false };
    }

    const text = message.content?.text ?? "";
    const parsed = parseAvailabilityText(text);

    if (!parsed || parsed.windows.length === 0) {
      await callback?.({
        text: 'I couldn\'t understand your availability. Try: "weekdays 9am-5pm" or "Monday afternoons"',
      });
      return { success: false };
    }

    const defaultTimeZone = process.env.DEFAULT_TIMEZONE ?? "America/New_York";
    let availability = await schedulingService.getAvailability(entityId);
    if (!availability) {
      availability = { timeZone: parsed.timeZone || defaultTimeZone, weekly: [], exceptions: [] };
    }
    if (parsed.timeZone) availability.timeZone = parsed.timeZone;

    for (const newWindow of parsed.windows) {
      const exists = availability.weekly.some(
        (w) =>
          w.day === newWindow.day &&
          w.startMinutes === newWindow.startMinutes &&
          w.endMinutes === newWindow.endMinutes
      );
      if (!exists) availability.weekly.push(newWindow);
    }

    await schedulingService.saveAvailability(entityId, availability);

    const addedWindows = parsed.windows
      .map((w) => `${formatDay(w.day)} ${formatTime(w.startMinutes)}-${formatTime(w.endMinutes)}`)
      .join(", ");

    await callback?.({
      text: `Got it! I've saved your availability: ${addedWindows}. I'll use this to find meeting times that work for you.`,
    });

    return { success: true };
  },
  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "I'm free weekdays 9am to 5pm" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Got it! I've saved your availability: Monday 9am-5pm, Tuesday 9am-5pm, Wednesday 9am-5pm, Thursday 9am-5pm, Friday 9am-5pm. I'll use this to find meeting times that work for you.",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Available Monday afternoons and Wednesday mornings" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Got it! I've saved your availability: Monday 12pm-5pm, Wednesday 9am-12pm. I'll use this to find meeting times that work for you.",
        },
      },
    ],
  ],
};
