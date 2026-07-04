// Defines the persona chained intents LifeOps scenario-runner spec.
import type { ScenarioContext } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  localWeekdayHourMinute,
  personaDentistFinalChecks,
} from "./_helpers/persona-dentist-outcome";

/**
 * Persona: run-on message chaining THREE intents in one breath —
 *   1. the shared persona task (dentist Thursday 3pm + day-before reminder),
 *   2. a reschedule ("move my 1:1 with priya to friday") against a
 *      pre-seeded once commitment that sits on a Tuesday, and
 *   3. a same-evening reminder ("remind me tonight to send the deck").
 *
 * All three outcomes are asserted against the persisted definition store,
 * not the reply text:
 *   - the dentist definition resolves to Thursday 15:00 (shared persona bar);
 *   - the Priya 1:1 definition's dueAt MOVES from its seeded Tuesday slot to
 *     a Friday (the pre-fix reschedule path returned the unchanged cadence
 *     while reporting "Updated" — see buildCadenceFromUpdateFields in
 *     plugins/plugin-personal-assistant/src/actions/life.ts);
 *   - a new "send the deck" once definition exists.
 */

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Next Tuesday 10:00 UTC, at least 4 days out — never a Friday, so the
 * Friday assertion below cannot pass without a real reschedule. */
function seededPriyaDueAt(): string {
  const base = new Date();
  base.setUTCHours(10, 0, 0, 0);
  let candidate = new Date(base);
  candidate.setUTCDate(candidate.getUTCDate() + 4);
  for (let i = 0; i <= 7; i += 1) {
    if (candidate.getUTCDay() === 2) return candidate.toISOString();
    candidate = new Date(candidate.getTime() + 24 * 60 * 60_000);
  }
  return candidate.toISOString();
}

const PRIYA_SEEDED_DUE_AT = seededPriyaDueAt();

async function readDefinitions(
  ctx: ScenarioContext,
): Promise<JsonRecord[] | string> {
  if (!ctx.apiBaseUrl) return "scenario apiBaseUrl unavailable";
  const response = await fetch(`${ctx.apiBaseUrl}/api/lifeops/definitions`);
  if (!response.ok) {
    return `GET /api/lifeops/definitions returned HTTP ${response.status}`;
  }
  const body = (await response.json()) as { definitions?: unknown };
  return (Array.isArray(body.definitions) ? body.definitions : [])
    .filter(isRecord)
    .map((row) => (isRecord(row.definition) ? row.definition : row));
}

async function assertPriyaMovedToFriday(
  ctx: ScenarioContext,
): Promise<string | undefined> {
  const definitions = await readDefinitions(ctx);
  if (typeof definitions === "string") return definitions;
  const priya = definitions.find(
    (definition) =>
      typeof definition.title === "string" &&
      definition.title.toLowerCase().includes("priya"),
  );
  if (!priya) {
    return `no persisted definition mentioning "priya"; saw titles: ${definitions
      .map((definition) => JSON.stringify(definition.title))
      .join(", ")}`;
  }
  const cadence = isRecord(priya.cadence) ? priya.cadence : null;
  if (cadence?.kind !== "once" || typeof cadence.dueAt !== "string") {
    return `expected priya once cadence with dueAt, saw ${JSON.stringify(cadence)}`;
  }
  if (cadence.dueAt === PRIYA_SEEDED_DUE_AT) {
    return `priya 1:1 dueAt is unchanged from the seeded Tuesday slot (${PRIYA_SEEDED_DUE_AT}) — the reschedule never happened`;
  }
  const timeZone =
    typeof priya.timezone === "string" && priya.timezone.length > 0
      ? priya.timezone
      : "UTC";
  const local = localWeekdayHourMinute(cadence.dueAt, timeZone);
  if (!local) return `priya dueAt ${cadence.dueAt} is not a valid instant`;
  return local.weekday === 5
    ? undefined
    : `priya 1:1 dueAt ${cadence.dueAt} (${timeZone}) resolved to weekday ${local.weekday}, expected Friday (5)`;
}

export default scenario({
  lane: "live-only",
  id: "persona-chained-intents",
  title:
    "Persona: 3-chained-intent run-on books the dentist, moves the Priya 1:1 to Friday, and adds a deck reminder",
  domain: "tasks",
  tags: ["lifeops", "tasks", "persona", "robustness", "multi-intent"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "Persona Chained Intents",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed the existing 1:1 with Priya on a Tuesday",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "1:1 with Priya",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: PRIYA_SEEDED_DUE_AT,
          visibilityLeadMinutes: 240,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
      assertResponse: (_status: number, body: unknown) => {
        const serialized =
          typeof body === "string" ? body : JSON.stringify(body ?? "");
        return serialized.includes("1:1 with Priya")
          ? undefined
          : "seed response does not include the Priya definition";
      },
    },
    {
      kind: "message",
      name: "three chained intents in one run-on message",
      text: "book dentist thursday 3pm and remind me the day before also move my 1:1 with priya to friday and remind me tonight to send the deck",
    },
    {
      kind: "message",
      name: "confirm everything",
      text: "yes do all three, save them",
    },
  ],
  finalChecks: [
    ...personaDentistFinalChecks(
      "persona-chained-intents: reply confirms the dentist on Thursday 3 PM + day-before reminder",
    ),
    {
      type: "custom",
      name: "priya 1:1 moved from its seeded Tuesday slot to a Friday",
      predicate: assertPriyaMovedToFriday,
    },
    {
      type: "definitionCountDelta",
      title: "Send the deck",
      titleAliases: ["deck", "send deck"],
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "judgeRubric",
      name: "persona-chained-intents: all three intents acknowledged distinctly",
      minimumScore: 0.6,
      rubric:
        "The assistant handled ALL THREE chained requests as distinct items: (1) a dentist appointment on Thursday at 3 PM with a day-before reminder, (2) moving the 1:1 with Priya to Friday, and (3) a reminder tonight to send the deck. Deduct for any intent that was dropped, merged into another, or acknowledged with the wrong day or time.",
    },
  ],
});
