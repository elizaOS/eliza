/**
 * Shared outcome assertions for the persona-* dentist scenarios.
 *
 * Every persona file expresses the SAME underlying task — "dentist
 * appointment Thursday 3pm + remind me the day before" — in a different
 * register (elderly non-technical, ESL, typo-heavy, voice-transcript,
 * chained run-on). The pass bar is identical for all of them and asserts
 * OUTCOMES, not echoes:
 *
 *   1. a `once` LifeOps definition for the dentist exists (persisted, read
 *      back through the real `/api/lifeops/definitions` route), and
 *   2. its resolved `cadence.dueAt` lands on a THURSDAY at 15:00 in the
 *      definition's own timezone — the datetime-extraction outcome that the
 *      pre-fix pipeline fabricated as `dueAt = now` (see
 *      `resolveOnceDueAt` in `plugins/plugin-personal-assistant/src/actions/life.ts`), and
 *   3. a day-before reminder is materialized: either a reminder-plan step at
 *      least 12 h before the appointment, or a separate once definition due
 *      the day before that references the dentist.
 *
 * The `_helpers` prefix keeps this file out of the scenario loader and the
 * corpus guards (loader skips `_`-prefixed entries).
 */

import type {
  ScenarioContext,
  ScenarioFinalCheck,
} from "@elizaos/scenario-runner/schema";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface DefinitionEntry {
  definition: JsonRecord;
  reminderPlan: JsonRecord | null;
}

async function listDefinitions(
  ctx: ScenarioContext,
): Promise<DefinitionEntry[] | string> {
  if (!ctx.apiBaseUrl) return "scenario apiBaseUrl unavailable";
  const response = await fetch(`${ctx.apiBaseUrl}/api/lifeops/definitions`);
  if (!response.ok) {
    return `GET /api/lifeops/definitions returned HTTP ${response.status}`;
  }
  const body = (await response.json()) as { definitions?: unknown };
  const rows = Array.isArray(body.definitions) ? body.definitions : [];
  const entries: DefinitionEntry[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const definition = isRecord(row.definition) ? row.definition : row;
    if (typeof definition.title !== "string") continue;
    entries.push({
      definition,
      reminderPlan: isRecord(row.reminderPlan)
        ? row.reminderPlan
        : isRecord(definition.reminderPlan)
          ? (definition.reminderPlan as JsonRecord)
          : null,
    });
  }
  return entries;
}

function titleIncludes(definition: JsonRecord, needle: string): boolean {
  return (
    typeof definition.title === "string" &&
    definition.title.toLowerCase().includes(needle.toLowerCase())
  );
}

export function localWeekdayHourMinute(
  iso: string,
  timeZone: string,
): { weekday: number; hour: number; minute: number } | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    }).formatToParts(date);
    const read = (type: string): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    const weekdayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    return {
      weekday: weekdayMap[read("weekday")] ?? -1,
      hour: Number.parseInt(read("hour"), 10) % 24,
      minute: Number.parseInt(read("minute"), 10),
    };
  } catch {
    return null;
  }
}

function definitionDueAt(
  definition: JsonRecord,
): { dueAtIso: string; timeZone: string } | string {
  const cadence = isRecord(definition.cadence) ? definition.cadence : null;
  if (cadence?.kind !== "once") {
    return `expected cadence.kind=once, saw ${JSON.stringify(cadence?.kind)}`;
  }
  if (typeof cadence.dueAt !== "string") {
    return `expected cadence.dueAt string, saw ${JSON.stringify(cadence.dueAt)}`;
  }
  const timeZone =
    typeof definition.timezone === "string" && definition.timezone.length > 0
      ? definition.timezone
      : "UTC";
  return { dueAtIso: cadence.dueAt, timeZone };
}

async function findDentistDefinition(
  ctx: ScenarioContext,
): Promise<DefinitionEntry | string> {
  const entries = await listDefinitions(ctx);
  if (typeof entries === "string") return entries;
  const dentist = entries.find((entry) =>
    titleIncludes(entry.definition, "dentist"),
  );
  return (
    dentist ??
    `no persisted definition mentioning "dentist"; saw titles: ${entries
      .map((entry) => JSON.stringify(entry.definition.title))
      .join(", ")}`
  );
}

/**
 * Outcome 2: the persisted dentist definition resolved "Thursday 3pm" to an
 * actual Thursday 15:00 wall-clock instant in its own timezone. Fails on the
 * pre-fix behaviors: fabricated `dueAt = now`, wrong weekday, or a dropped
 * time-of-day.
 */
export async function assertDentistThursday3pm(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const dentist = await findDentistDefinition(ctx);
  if (typeof dentist === "string") return dentist;
  const due = definitionDueAt(dentist.definition);
  if (typeof due === "string") {
    return `dentist definition ${JSON.stringify(dentist.definition.title)}: ${due}`;
  }
  const local = localWeekdayHourMinute(due.dueAtIso, due.timeZone);
  if (!local) {
    return `dentist dueAt ${due.dueAtIso} is not a valid instant`;
  }
  if (local.weekday !== 4) {
    return `dentist dueAt ${due.dueAtIso} (${due.timeZone}) resolved to weekday ${local.weekday}, expected Thursday (4)`;
  }
  if (local.hour !== 15 || local.minute !== 0) {
    return `dentist dueAt ${due.dueAtIso} (${due.timeZone}) resolved to ${local.hour}:${String(local.minute).padStart(2, "0")}, expected 15:00`;
  }
  if (new Date(due.dueAtIso).getTime() <= Date.now()) {
    return `dentist dueAt ${due.dueAtIso} is in the past — a fabricated immediate dueAt, not the requested Thursday`;
  }
  return undefined;
}

function reminderPlanStepsOf(entry: DefinitionEntry): JsonRecord[] {
  const plan = entry.reminderPlan;
  if (!plan) return [];
  const steps = plan.steps;
  return Array.isArray(steps) ? steps.filter(isRecord) : [];
}

/**
 * Outcome 3: "remind me the day before" materialized as either a reminder
 * step at least 12 hours before the appointment or a separate once
 * definition due the previous day that references the dentist.
 */
export async function assertDayBeforeReminder(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const dentist = await findDentistDefinition(ctx);
  if (typeof dentist === "string") return dentist;
  const due = definitionDueAt(dentist.definition);
  if (typeof due === "string") return due;
  const dueMs = new Date(due.dueAtIso).getTime();

  const earlySteps = reminderPlanStepsOf(dentist).filter((step) => {
    const offset = step.offsetMinutes;
    return typeof offset === "number" && offset <= -12 * 60;
  });
  if (earlySteps.length > 0) return undefined;

  const entries = await listDefinitions(ctx);
  if (typeof entries === "string") return entries;
  const dayBefore = entries.find((entry) => {
    if (entry.definition === dentist.definition) return false;
    if (!titleIncludes(entry.definition, "dentist")) return false;
    const otherDue = definitionDueAt(entry.definition);
    if (typeof otherDue === "string") return false;
    const otherMs = new Date(otherDue.dueAtIso).getTime();
    // Due before the appointment, by at least 12h and at most 48h.
    const lead = dueMs - otherMs;
    return lead >= 12 * 60 * 60_000 && lead <= 48 * 60 * 60_000;
  });
  return dayBefore
    ? undefined
    : "no day-before reminder found: the dentist definition has no reminder step >=12h early and no separate dentist definition due the previous day";
}

/**
 * The shared persona final-check block. `judgeLabel` names the rubric check
 * per persona so failures are attributable.
 */
export function personaDentistFinalChecks(
  judgeLabel: string,
): ScenarioFinalCheck[] {
  return [
    {
      type: "definitionCountDelta",
      title: "Dentist",
      titleAliases: [
        "Dentist appointment",
        "Dentist appointment Thursday",
        "Dentist checkup",
        "Call the dentist",
      ],
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "custom",
      name: "dentist dueAt resolved to Thursday 15:00 in the owner timezone",
      predicate: assertDentistThursday3pm,
    },
    {
      type: "custom",
      name: "day-before reminder materialized",
      predicate: assertDayBeforeReminder,
    },
    {
      type: "judgeRubric",
      name: judgeLabel,
      minimumScore: 0.6,
      rubric:
        "The assistant's replies explicitly confirm the dentist appointment on THURSDAY and at 3 PM (15:00) — stating the resolved day and time back to the user, not merely repeating the user's own garbled words — and acknowledge that a reminder will arrive the day before (Wednesday). Deduct if the confirmed day or time is wrong, missing, or only implied.",
    },
  ];
}
