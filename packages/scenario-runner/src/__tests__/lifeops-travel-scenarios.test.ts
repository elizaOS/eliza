import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const travelScenarioDir = resolve(
  repoRoot,
  "packages/test/scenarios/lifeops.travel",
);

const EXPECTED_TRAVEL_SCENARIO_IDS = [
  "travel.asset-deadline-checklist",
  "travel.book-flight-after-approval",
  "travel.book-hotel-with-loyalty-number",
  "travel.cancel-trip-rollback-events",
  "travel.capture-preferences-first-time",
  "travel.cross-tz-itinerary-formatting",
  "travel.duffel-cloud-relay",
  "travel.flight-conflict-rebook",
  "travel.itinerary-brief-with-links",
  "travel.layover-too-tight-warning",
  "travel.partial-day-trip-no-hotel",
  "travel.passport-expiry-warning",
  "travel.recurring-business-trip-template",
  "travel.travel-blackout-defends-no-booking-during-focus",
  "travel.upgrade-offer-flagged-for-approval",
] as const;

type ScenarioShape = {
  id?: string;
  domain?: string;
  tags?: string[];
  turns?: Array<Record<string, unknown>>;
  finalChecks?: Array<Record<string, unknown>>;
};

async function loadTravelScenarios(): Promise<ScenarioShape[]> {
  const files = readdirSync(travelScenarioDir)
    .filter((file) => file.endsWith(".scenario.ts"))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const mod = (await import(
        pathToFileURL(resolve(travelScenarioDir, file)).href
      )) as { default?: ScenarioShape };
      return mod.default ?? {};
    }),
  );
}

describe("LifeOps travel scenarios", () => {
  it("keeps every travel scenario registered as a durable scenario file", async () => {
    const scenarios = await loadTravelScenarios();
    const ids = scenarios.map((scenario) => scenario.id).sort();

    expect(ids).toEqual([...EXPECTED_TRAVEL_SCENARIO_IDS].sort());
    expect(new Set(ids).size).toBe(EXPECTED_TRAVEL_SCENARIO_IDS.length);
  });

  it("covers booking, safety, itinerary, and preference variants", async () => {
    const scenarios = await loadTravelScenarios();
    const tags = new Set(scenarios.flatMap((scenario) => scenario.tags ?? []));

    for (const scenario of scenarios) {
      expect(scenario.domain).toBe("lifeops.travel");
      expect(scenario.tags).toContain("lifeops");
      expect(scenario.tags).toContain("travel");
      expect(scenario.turns?.length ?? 0).toBeGreaterThan(0);
      expect(scenario.finalChecks?.length ?? 0).toBeGreaterThan(0);
      expect(
        scenario.finalChecks?.some(
          (check) =>
            check.type === "selectedAction" ||
            check.type === "custom" ||
            check.type === "judgeRubric" ||
            (typeof check.name === "string" && check.name.includes("rubric")),
        ),
      ).toBe(true);
    }

    expect(Array.from(tags)).toEqual(
      expect.arrayContaining([
        "approval",
        "duffel",
        "calendar",
        "conflict",
        "itinerary",
        "passport",
        "preferences",
        "profile",
        "risk",
        "timezone",
      ]),
    );
  });
});
