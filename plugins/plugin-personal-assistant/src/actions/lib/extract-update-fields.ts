/**
 * LLM extractor for owner life-item update requests. Pulls the fields a user
 * wants to change — title, cadence, priority, time-of-day — from a
 * natural-language edit, validating the cadence kind against the known set so
 * the update flow only applies recognized fields.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { parseJsonModelRecord, runExtractorPipeline } from "@elizaos/core";

const VALID_CADENCE_KINDS = new Set([
  "once",
  "daily",
  "weekly",
  "times_per_day",
  "interval",
]);

export interface ExtractedUpdateFields {
  title: string | null;
  cadenceKind: string | null;
  windows: string[] | null;
  weekdays: number[] | null;
  timeOfDay: string | null;
  everyMinutes: number | null;
  priority: number | null;
  description: string | null;
  /**
   * Date-level reschedules for "once" tasks, mirroring the create
   * extractor (`extract-task-plan.ts`): "move it to april 17" →
   * `dueDate: "2026-04-17"`; "push it to tomorrow" → `dueInDays: 1`;
   * "make it Friday instead" → `dueWeekday: 5`; "in 2 hours" →
   * `dueInMinutes: 120`. At most one is set; all null when the user only
   * changed the time-of-day or other fields.
   */
  dueDate: string | null;
  dueInDays: number | null;
  dueWeekday: number | null;
  dueInMinutes: number | null;
}

const EMPTY_UPDATE_FIELDS: ExtractedUpdateFields = {
  title: null,
  cadenceKind: null,
  windows: null,
  weekdays: null,
  timeOfDay: null,
  everyMinutes: null,
  priority: null,
  description: null,
  dueDate: null,
  dueInDays: null,
  dueWeekday: null,
  dueInMinutes: null,
};

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validateDueDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = LOCAL_DATE_RE.exec(value.trim());
  if (!match) return null;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return match[0];
}

function validateNonNegativeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return null;
  }
  return value;
}

function validateDueWeekday(value: unknown): number | null {
  const validated = validateNonNegativeInteger(value);
  return validated !== null && validated <= 6 ? validated : null;
}

function promptText(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : "(empty)";
}

function parseStructuredRecord(raw: string): Record<string, unknown> | null {
  return parseJsonModelRecord<Record<string, unknown>>(raw);
}

function parseTimeOfDay(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  const hhmmMatch = normalized.match(/\b(\d{1,2}):(\d{2})\b/);
  if (hhmmMatch) {
    const hour = Number(hhmmMatch[1]);
    const minute = Number(hhmmMatch[2]);
    if (
      Number.isFinite(hour) &&
      Number.isFinite(minute) &&
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute < 60
    ) {
      return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }

  const clockMatch = normalized.match(
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(noon|midnight)\b/,
  );
  if (!clockMatch) {
    return null;
  }
  if (clockMatch[4] === "noon") {
    return "12:00";
  }
  if (clockMatch[4] === "midnight") {
    return "00:00";
  }
  const rawHour = Number(clockMatch[1]);
  const minute = Number(clockMatch[2] ?? "0");
  const meridiem = clockMatch[3];
  const hour =
    meridiem === "am"
      ? rawHour % 12
      : rawHour % 12 === 0
        ? 12
        : (rawHour % 12) + 12;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function validateTitle(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function validateCadenceKind(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return VALID_CADENCE_KINDS.has(normalized) ? normalized : null;
}

function validateWindows(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value
    .filter((item: unknown) => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : null;
}

function validateWeekdays(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const normalized = value.filter(
    (item: unknown) =>
      typeof item === "number" &&
      Number.isInteger(item) &&
      item >= 0 &&
      item <= 6,
  );
  return normalized.length > 0 ? normalized : null;
}

function validatePositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

function validatePriority(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(1, Math.min(5, Math.round(value)));
}

function buildUpdateFields(
  parsed: Record<string, unknown>,
): ExtractedUpdateFields {
  return {
    title: validateTitle(parsed.title),
    cadenceKind: validateCadenceKind(parsed.cadenceKind),
    windows: validateWindows(parsed.windows),
    weekdays: validateWeekdays(parsed.weekdays),
    timeOfDay:
      typeof parsed.timeOfDay === "string"
        ? parseTimeOfDay(parsed.timeOfDay)
        : null,
    everyMinutes: validatePositiveNumber(parsed.everyMinutes),
    priority: validatePriority(parsed.priority),
    description: validateTitle(parsed.description),
    dueDate: validateDueDate(parsed.dueDate),
    dueInDays: validateNonNegativeInteger(parsed.dueInDays),
    dueWeekday: validateDueWeekday(parsed.dueWeekday),
    dueInMinutes: validateNonNegativeInteger(parsed.dueInMinutes),
  };
}

function buildRepairPrompt(args: {
  intent: string;
  currentTitle: string;
  currentCadenceKind: string;
  currentWindows: string[];
  rawResponse: string;
}): string {
  return [
    "Your last reply for the LifeOps update extractor was invalid.",
    "Return ONLY a valid JSON object with exactly these fields:",
    "title, cadenceKind, windows, weekdays, timeOfDay, everyMinutes, priority, description, dueDate, dueInDays, dueWeekday, dueInMinutes",
    "",
    "Use null for any field the user did not ask to change.",
    "cadenceKind must be one of: once, daily, weekly, times_per_day, interval.",
    'timeOfDay must be HH:MM 24h format like "06:00" when present.',
    'dueDate must be "YYYY-MM-DD"; dueInDays/dueWeekday/dueInMinutes must be integers; set at most ONE of the four.',
    "",
    `Current task: ${promptText(args.currentTitle)}`,
    `Current cadence kind: ${promptText(args.currentCadenceKind)}`,
    `Current windows: [${args.currentWindows.join(", ")}]`,
    `User request: ${promptText(args.intent)}`,
    "Previous invalid output:",
    promptText(args.rawResponse),
  ].join("\n");
}

/**
 * When the LLM caller passes an update_definition intent without pre-parsed
 * structured fields (e.g. "change my workout to 6am"), this function asks
 * a large text model to extract which fields the user actually wants to change.
 *
 * Returns an explicit empty update object when the model is unavailable or the
 * response is unparseable, so callers do not need heuristic fallbacks.
 */
export async function extractUpdateFieldsWithLlm(args: {
  runtime: IAgentRuntime;
  intent: string;
  currentTitle: string;
  currentCadenceKind: string;
  currentWindows: string[];
}): Promise<ExtractedUpdateFields> {
  const { runtime, intent, currentTitle, currentCadenceKind, currentWindows } =
    args;

  const prompt = [
    "The user wants to update an existing task/habit. Extract ONLY the fields they want to change.",
    "Return null for fields the user did NOT mention changing.",
    "",
    `Current task: "${currentTitle}"`,
    `Current schedule: ${currentCadenceKind}, windows: [${currentWindows.join(", ")}]`,
    "",
    "Return a JSON object with these fields (null = no change requested):",
    "- title: new name if user wants to rename",
    "- cadenceKind: new schedule type if changing (once/daily/weekly/times_per_day/interval)",
    "- windows: new time windows if changing (morning/afternoon/evening/night)",
    "- weekdays: new weekday numbers if changing (0=Sun..6=Sat)",
    '- timeOfDay: new specific time like "06:00" if changing time',
    "- everyMinutes: new interval if changing",
    "- priority: new priority 1-5 if changing",
    "- description: new description if changing",
    '- dueDate: for one-off tasks, the new local calendar date "YYYY-MM-DD" when the user names a specific date ("move it to april 17" — infer the next future occurrence)',
    '- dueInDays: whole days from today for relative day words ("push it to tomorrow" -> 1)',
    '- dueWeekday: weekday number (0=Sun..6=Sat) when the user names a weekday ("make it Friday instead" -> 5)',
    '- dueInMinutes: minutes from now for offsets ("in 2 hours" -> 120)',
    "  Set at most ONE of dueDate/dueInDays/dueWeekday/dueInMinutes; all null unless the user moved a one-off task's date.",
    "",
    'Example time change: {"title":null,"cadenceKind":null,"windows":null,"weekdays":null,"timeOfDay":"06:00","everyMinutes":null,"priority":null,"description":null,"dueDate":null,"dueInDays":null,"dueWeekday":null,"dueInMinutes":null}',
    'Example rename: {"title":"Morning run","cadenceKind":null,"windows":null,"weekdays":null,"timeOfDay":null,"everyMinutes":null,"priority":null,"description":null,"dueDate":null,"dueInDays":null,"dueWeekday":null,"dueInMinutes":null}',
    'Example date move ("move the dentist reminder to friday at 3pm"): {"title":null,"cadenceKind":null,"windows":null,"weekdays":null,"timeOfDay":"15:00","everyMinutes":null,"priority":null,"description":null,"dueDate":null,"dueInDays":null,"dueWeekday":5,"dueInMinutes":null}',
    "",
    "Return ONLY valid JSON. No prose, markdown, code fences, or any other format.",
    "",
    `User request: ${promptText(intent)}`,
  ].join("\n");

  const { parsed } = await runExtractorPipeline({
    runtime,
    prompt,
    parser: (raw) => {
      const parsedObject = parseStructuredRecord(raw);
      return parsedObject ? buildUpdateFields(parsedObject) : null;
    },
    buildRepairPrompt: (rawFirstPass) =>
      buildRepairPrompt({
        intent,
        currentTitle,
        currentCadenceKind,
        currentWindows,
        rawResponse: rawFirstPass,
      }),
  });

  return parsed ?? { ...EMPTY_UPDATE_FIELDS };
}
