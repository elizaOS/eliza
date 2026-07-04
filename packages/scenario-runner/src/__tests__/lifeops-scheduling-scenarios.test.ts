/** Corpus guard for the LifeOps scheduling scenarios: loads every `.scenario.ts` under packages/test/scenarios/lifeops.scheduling and asserts the expected scenario-id set is present and well-formed (no live model). */
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const schedulingScenarioDir = resolve(
  repoRoot,
  "packages/test/scenarios/lifeops.scheduling",
);

const EXPECTED_SCHEDULING_SCENARIO_IDS = [
  "scheduling.attendee-counter-proposes",
  "scheduling.calendly-link-generation",
  "scheduling.confirm-time-creates-event",
  "scheduling.find-mutual-slots-across-attendees",
  "scheduling.preference-storage-survives-restart",
  "scheduling.propose-3-options-for-1hr",
  "scheduling.propose-honors-buffer-prefs",
  "scheduling.propose-respects-blackouts",
  "scheduling.propose-times-with-attendees",
  "scheduling.reject-all-proposals-asks-clarify",
  "scheduling.timezone-respectful-proposal",
  "scheduling.weekend-availability-toggle",
] as const;

type ScenarioShape = {
  id?: string;
  domain?: string;
  tags?: string[];
  turns?: Array<Record<string, unknown>>;
  finalChecks?: Array<Record<string, unknown>>;
};

async function loadSchedulingScenarios(): Promise<ScenarioShape[]> {
  const files = readdirSync(schedulingScenarioDir)
    .filter((file) => file.endsWith(".scenario.ts"))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const mod = (await import(
        pathToFileURL(resolve(schedulingScenarioDir, file)).href
      )) as { default?: ScenarioShape };
      return mod.default ?? {};
    }),
  );
}

describe("LifeOps scheduling scenarios", () => {
  it("keeps every scheduling scenario registered as a durable scenario file", async () => {
    const scenarios = await loadSchedulingScenarios();
    const ids = scenarios.map((scenario) => scenario.id).sort();

    expect(ids).toEqual([...EXPECTED_SCHEDULING_SCENARIO_IDS].sort());
    expect(new Set(ids).size).toBe(EXPECTED_SCHEDULING_SCENARIO_IDS.length);
  });

  it("covers assistant scheduling, Calendly handoff, and preference safety", async () => {
    const scenarios = await loadSchedulingScenarios();
    const tags = new Set(scenarios.flatMap((scenario) => scenario.tags ?? []));

    for (const scenario of scenarios) {
      expect(scenario.domain).toBe("lifeops.scheduling");
      expect(scenario.tags).toContain("lifeops");
      expect(scenario.tags).toContain("scheduling");
      expect(scenario.turns?.length ?? 0).toBeGreaterThan(0);
      expect(scenario.finalChecks?.length ?? 0).toBeGreaterThan(0);
      expect(
        scenario.finalChecks?.some(
          (check) =>
            check.type === "custom" ||
            check.type === "selectedAction" ||
            check.type === "judgeRubric" ||
            (typeof check.name === "string" && check.name.includes("rubric")),
        ),
      ).toBe(true);
    }

    expect(Array.from(tags)).toEqual(
      expect.arrayContaining([
        "attendees",
        "blackouts",
        "calendly",
        "confirmation",
        "multi-attendee",
        "negotiation",
        "persistence",
        "preferences",
        "propose-times",
        "timezone",
        "weekend",
      ]),
    );
  });
});
