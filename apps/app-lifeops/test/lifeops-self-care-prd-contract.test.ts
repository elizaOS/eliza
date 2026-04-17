import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock(
  "@elizaos/scenario-schema",
  () => ({
    scenario: <T>(value: T) => value,
  }),
  { virtual: true },
);

type JsonScenario = {
  id: string;
  title: string;
  domain: string;
  description?: string;
  requiresIsolation?: boolean;
  rooms?: Array<Record<string, unknown>>;
  turns: Array<Record<string, unknown>>;
  finalChecks?: Array<Record<string, unknown>>;
};

type TsScenario = {
  id: string;
  title: string;
  domain: string;
  description?: string;
  isolation?: string;
  rooms?: Array<Record<string, unknown>>;
  turns: Array<Record<string, unknown>>;
  finalChecks?: Array<Record<string, unknown>>;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const JSON_SCENARIO_DIR = path.join(
  REPO_ROOT,
  "eliza",
  "apps",
  "app-lifeops",
  "scenarios",
);
const TS_PRD_SCENARIO_DIR = path.join(REPO_ROOT, "test", "scenarios", "lifeops");
const TS_HABIT_SCENARIO_DIR = path.join(
  REPO_ROOT,
  "test",
  "scenarios",
  "lifeops.habits",
);

const SELF_CARE_PRD_SCENARIO_IDS = [
  "workout-blocker-basic",
  "stretch-breaks",
  "goal-sleep-basic",
  "shower-weekly-basic",
  "shave-weekly-formal",
  "brush-teeth-basic",
  "brush-teeth-bedtime-wakeup",
  "brush-teeth-night-owl",
  "brush-teeth-repeat-confirm",
  "brush-teeth-retry-after-cancel",
  "brush-teeth-cancel",
  "brush-teeth-spanish",
  "brush-teeth-smalltalk-preference",
  "vitamins-with-meals",
  "water-default-frequency",
  "invisalign-weekday-lunch",
] as const;

const SELF_CARE_HABIT_SCENARIO_IDS = [
  "habit.sit-ups-push-ups.daily-counts",
  "habit.morning-routine.full-stack",
  "habit.night-routine.full-stack",
] as const;

async function loadJsonScenario(id: string): Promise<JsonScenario> {
  const raw = await readFile(path.join(JSON_SCENARIO_DIR, `${id}.json`), "utf8");
  return JSON.parse(raw) as JsonScenario;
}

async function loadTsScenario(
  directory: string,
  id: string,
): Promise<TsScenario> {
  const module = await import(
    pathToFileURL(path.join(directory, `${id}.scenario.ts`)).href
  );
  return module.default as TsScenario;
}

function normalizeScenarioTurn(
  turn: Record<string, unknown>,
): Record<string, unknown> {
  const kind = String(turn.kind ?? "message");
  if (kind === "message") {
    const { kind: _kind, ...rest } = turn;
    return rest;
  }

  if (kind === "api") {
    const {
      kind: _kind,
      method,
      path: apiPath,
      body,
      expectedStatus,
      assertResponse: _assertResponse,
      ...rest
    } = turn;

    const normalized: Record<string, unknown> = {
      ...rest,
      apiRequest: {
        method,
        path: apiPath,
        ...(body === undefined ? {} : { body }),
      },
    };

    if (expectedStatus !== undefined) {
      normalized.apiStatus = expectedStatus;
    }

    return normalized;
  }

  throw new Error(`Unsupported scenario turn kind: ${kind}`);
}

function normalizeScenarioShape(
  scenario: JsonScenario | TsScenario,
): Record<string, unknown> {
  return {
    id: scenario.id,
    title: scenario.title,
    domain: scenario.domain,
    ...(scenario.description ? { description: scenario.description } : {}),
    rooms: scenario.rooms ?? [],
    turns: scenario.turns.map(normalizeScenarioTurn),
    finalChecks: scenario.finalChecks ?? [],
  };
}

function getFinalCheck(
  scenario: JsonScenario | TsScenario,
  title: string,
): Record<string, unknown> {
  const match = (scenario.finalChecks ?? []).find(
    (check) => String(check.title ?? "") === title,
  );
  if (!match) {
    throw new Error(
      `Missing final check "${title}" in scenario "${scenario.id}"`,
    );
  }
  return match;
}

describe("LifeOps self-care PRD scenario contracts", () => {
  for (const scenarioId of SELF_CARE_PRD_SCENARIO_IDS) {
    it(`${scenarioId} stays aligned between JSON PRD fixtures and TS scenarios`, async () => {
      const [jsonScenario, tsScenario] = await Promise.all([
        loadJsonScenario(scenarioId),
        loadTsScenario(TS_PRD_SCENARIO_DIR, scenarioId),
      ]);

      expect(normalizeScenarioShape(tsScenario)).toEqual(
        normalizeScenarioShape(jsonScenario),
      );
    });
  }

  it("keeps workout and self-care scenarios meaningfully post-validated", async () => {
    const scenarios = Object.fromEntries(
      await Promise.all(
        [
          "workout-blocker-basic",
          "stretch-breaks",
          "goal-sleep-basic",
          "shower-weekly-basic",
          "shave-weekly-formal",
          "water-default-frequency",
          "vitamins-with-meals",
          "invisalign-weekday-lunch",
        ].map(async (scenarioId) => [
          scenarioId,
          await loadJsonScenario(scenarioId),
        ]),
      ),
    ) as Record<string, JsonScenario>;

    expect(getFinalCheck(scenarios["workout-blocker-basic"], "Workout")).toEqual(
      expect.objectContaining({
        type: "definitionCountDelta",
        cadenceKind: "daily",
        requiredWindows: ["afternoon"],
        requireReminderPlan: true,
        websiteAccess: {
          unlockMode: "fixed_duration",
          unlockDurationMinutes: 60,
          websites: [
            "x.com",
            "twitter.com",
            "instagram.com",
            "news.ycombinator.com",
          ],
        },
      }),
    );

    expect(getFinalCheck(scenarios["stretch-breaks"], "Stretch")).toEqual(
      expect.objectContaining({
        type: "definitionCountDelta",
        cadenceKind: "interval",
        requiredEveryMinutes: 360,
        requiredMaxOccurrencesPerDay: 2,
        requiredWindows: ["afternoon", "evening"],
        requireReminderPlan: true,
      }),
    );

    expect(
      getFinalCheck(scenarios["goal-sleep-basic"], "Stabilize Sleep Schedule"),
    ).toEqual(
      expect.objectContaining({
        type: "goalCountDelta",
        expectedStatus: "active",
        expectedReviewState: "idle",
        requireDescription: true,
        requireSuccessCriteria: true,
        requireSupportStrategy: true,
        expectedGroundingState: "grounded",
      }),
    );

    expect(getFinalCheck(scenarios["shower-weekly-basic"], "Shower")).toEqual(
      expect.objectContaining({
        type: "definitionCountDelta",
        cadenceKind: "weekly",
        requiredWeekdays: [1, 3, 5],
        requiredWindows: ["morning", "night"],
        requireReminderPlan: true,
      }),
    );

    expect(getFinalCheck(scenarios["shave-weekly-formal"], "Shave")).toEqual(
      expect.objectContaining({
        type: "definitionCountDelta",
        cadenceKind: "weekly",
        requiredWeekdays: [1, 4],
        requiredWindows: ["morning"],
        requireReminderPlan: true,
      }),
    );

    expect(
      getFinalCheck(scenarios["water-default-frequency"], "Drink water"),
    ).toEqual(
      expect.objectContaining({
        type: "definitionCountDelta",
        cadenceKind: "interval",
        requiredEveryMinutes: 180,
        requiredMaxOccurrencesPerDay: 4,
        requiredWindows: ["morning", "afternoon", "evening"],
        requireReminderPlan: true,
      }),
    );

    expect(
      getFinalCheck(scenarios["vitamins-with-meals"], "Take vitamins"),
    ).toEqual(
      expect.objectContaining({
        type: "definitionCountDelta",
        cadenceKind: "daily",
        requiredWindows: ["afternoon"],
        requireReminderPlan: true,
      }),
    );

    expect(
      getFinalCheck(
        scenarios["invisalign-weekday-lunch"],
        "Keep Invisalign in",
      ),
    ).toEqual(
      expect.objectContaining({
        type: "definitionCountDelta",
        cadenceKind: "weekly",
        requiredWeekdays: [1, 2, 3, 4, 5],
        requiredWindows: ["afternoon"],
        requireReminderPlan: true,
      }),
    );
  });

  it("keeps newer workout and self-care habit scenarios structurally testable", async () => {
    const [dailyCounts, morningRoutine, nightRoutine] = await Promise.all(
      SELF_CARE_HABIT_SCENARIO_IDS.map((scenarioId) =>
        loadTsScenario(TS_HABIT_SCENARIO_DIR, scenarioId),
      ),
    );

    expect(
      getFinalCheck(dailyCounts, "Push-ups and sit-ups"),
    ).toEqual(
      expect.objectContaining({
        type: "definitionCountDelta",
        cadenceKind: "daily",
        requiredWindows: ["morning"],
        requireReminderPlan: true,
      }),
    );

    expect(morningRoutine.finalChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "definitionCountDelta",
          title: "Brush teeth",
          requireReminderPlan: true,
        }),
        expect.objectContaining({
          type: "definitionCountDelta",
          title: "Stretch",
          requireReminderPlan: true,
        }),
        expect.objectContaining({
          type: "definitionCountDelta",
          title: "Drink water",
          requireReminderPlan: true,
        }),
        expect.objectContaining({
          type: "definitionCountDelta",
          title: "Take vitamins",
          requireReminderPlan: true,
        }),
      ]),
    );
    expect(morningRoutine.finalChecks).toHaveLength(4);

    expect(nightRoutine.finalChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "definitionCountDelta",
          title: "Brush teeth",
          requireReminderPlan: true,
        }),
        expect.objectContaining({
          type: "definitionCountDelta",
          title: "Stretch",
          requireReminderPlan: true,
        }),
        expect.objectContaining({
          type: "definitionCountDelta",
          title: "Wind down",
          requireReminderPlan: true,
        }),
      ]),
    );
    expect(nightRoutine.finalChecks).toHaveLength(3);
  });
});
