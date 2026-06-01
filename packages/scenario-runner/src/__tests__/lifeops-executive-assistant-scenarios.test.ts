import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const executiveScenarioDir = resolve(
  repoRoot,
  "packages/test/scenarios/lifeops.executive-assistant",
);

const EXPECTED_EXECUTIVE_SCENARIO_IDS = [
  "executive.command-brief-risk-triage",
  "executive.document-signature-review",
  "executive.end-of-day-closeout",
  "executive.expense-capture",
  "executive.home-ops",
  "executive.meeting-prep-docs-people",
  "executive.people-cadence",
  "executive.renewals-keep-cancel",
  "executive.travel-readiness",
  "executive.waiting-on-cross-channel",
] as const;

type ScenarioShape = {
  id?: string;
  domain?: string;
  tags?: string[];
  turns?: Array<Record<string, unknown>>;
  finalChecks?: Array<Record<string, unknown>>;
};

async function loadExecutiveScenarios(): Promise<ScenarioShape[]> {
  const files = readdirSync(executiveScenarioDir)
    .filter((file) => file.endsWith(".scenario.ts"))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const mod = (await import(
        pathToFileURL(resolve(executiveScenarioDir, file)).href
      )) as { default?: ScenarioShape };
      return mod.default ?? {};
    }),
  );
}

describe("LifeOps executive assistant scenarios", () => {
  it("covers the assistant command surface with durable scenario files", async () => {
    const scenarios = await loadExecutiveScenarios();
    const ids = scenarios.map((scenario) => scenario.id).sort();

    expect(ids).toEqual([...EXPECTED_EXECUTIVE_SCENARIO_IDS].sort());
    expect(new Set(ids).size).toBe(EXPECTED_EXECUTIVE_SCENARIO_IDS.length);
  });

  it("keeps every executive scenario chat-first and evaluation-backed", async () => {
    const scenarios = await loadExecutiveScenarios();

    for (const scenario of scenarios) {
      expect(scenario.domain).toBe("lifeops.executive-assistant");
      expect(scenario.tags).toContain("lifeops");
      expect(scenario.tags).toContain("executive-assistant");
      expect(scenario.turns?.length ?? 0).toBeGreaterThan(0);

      const userText = scenario.turns
        ?.map((turn) => String(turn.text ?? ""))
        .join("\n");
      expect(userText).toMatch(
        /brief|prep|waiting|travel|expense|renewal|relationship|doc|home|closeout/i,
      );

      const hasActionCheck = scenario.finalChecks?.some(
        (check) => check.type === "selectedAction" || check.type === "custom",
      );
      const hasRubric = scenario.finalChecks?.some(
        (check) =>
          check.type === "judgeRubric" ||
          (typeof check.name === "string" && check.name.includes("rubric")),
      );
      expect(hasActionCheck).toBe(true);
      expect(hasRubric).toBe(true);
    }
  });
});
