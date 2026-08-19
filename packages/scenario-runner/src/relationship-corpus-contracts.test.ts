/** Guards relationship scenarios against stale action names and fabricated capability claims. */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scenarioRoot = resolve(repoRoot, "packages/test/scenarios/relationships");

async function loadScenarios(): Promise<ScenarioDefinition[]> {
  const files = readdirSync(scenarioRoot)
    .filter((file) => file.endsWith(".scenario.ts"))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const loaded = (await import(
        pathToFileURL(resolve(scenarioRoot, file)).href
      )) as { default: ScenarioDefinition };
      return loaded.default;
    }),
  );
}

describe("relationship corpus contracts", () => {
  it("has no pending relationship contracts", async () => {
    const scenarios = await loadScenarios();
    const pendingIds = scenarios
      .filter((scenario) => scenario.status === "pending")
      .map((scenario) => scenario.id)
      .sort();
    expect(pendingIds).toEqual([]);
  });

  it("executes cadence, brief, and goal contracts through canonical actions", async () => {
    const scenarios = await loadScenarios();
    const expectedAction = new Map([
      ["followup.daily-digest", "BRIEF"],
      ["followup.threshold-14-days", "SCHEDULED_TASKS"],
      ["followup.track-overdue", "SCHEDULED_TASKS"],
      ["relationships.status-goals.progress", "CONTACT"],
      ["relationships.status-goals.set", "CONTACT"],
      ["relationships.import-from-platform", "CONTACT"],
    ]);
    for (const [id, actionName] of expectedAction) {
      const scenario = scenarios.find((candidate) => candidate.id === id);
      expect(scenario?.status).not.toBe("pending");
      expect(scenario?.lane).toBe("pr-deterministic");
      expect(scenario?.turns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "action", actionName }),
        ]),
      );
      expect(scenario?.finalChecks).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "custom" })]),
      );
    }
  });

  it("uses canonical CONTACT operations and durable custom checks", async () => {
    const scenarios = await loadScenarios();
    for (const id of [
      "rolodex.add-contact",
      "rolodex.search",
      "rolodex.update-notes",
    ]) {
      const scenario = scenarios.find((candidate) => candidate.id === id);
      expect(scenario?.status).not.toBe("pending");
      expect(scenario?.turns).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ expectedActions: ["CONTACT"] }),
        ]),
      );
      expect(scenario?.finalChecks).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "custom" })]),
      );
    }
  });

  it("keeps draft scenarios channel-specific and proves no pre-approval dispatch", async () => {
    const scenarios = await loadScenarios();
    for (const channel of ["discord", "gmail", "telegram"] as const) {
      const scenario = scenarios.find(
        (candidate) => candidate.id === `followup.draft.${channel}`,
      );
      expect(scenario?.tags).not.toContain("cross-platform");
      expect(scenario?.finalChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "connectorDispatchOccurred",
            channel,
            expected: false,
            maxCount: 0,
          }),
        ]),
      );
    }
  });

  it("contains no stale relationship umbrella or legacy leaf action assertions", () => {
    const source = readdirSync(scenarioRoot)
      .filter((file) => file.endsWith(".scenario.ts"))
      .map((file) => readFileSync(resolve(scenarioRoot, file), "utf8"))
      .join("\n");
    for (const staleName of [
      "ADD_CONTACT",
      "SEARCH_CONTACTS",
      "UPDATE_CONTACT",
      'actionName: "RELATIONSHIP"',
    ]) {
      expect(source).not.toContain(staleName);
    }
  });
});
