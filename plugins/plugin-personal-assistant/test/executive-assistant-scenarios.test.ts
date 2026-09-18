/**
 * Validates the scenario corpus through the real discovery and module loader.
 * IDs remain unique and discoverable, and every loaded scenario declares
 * runnable turns and assertions. This preflight does not execute the scenarios.
 */
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ScenarioDefinition } from "@elizaos/scenario-runner/schema";
import { describe, expect, it } from "vitest";
import {
  discoverScenarios,
  loadScenarioFile,
} from "../../../packages/scenario-runner/src/loader.ts";

const here = dirname(fileURLToPath(import.meta.url));
const scenarioDir = resolve(here, "scenarios");

/**
 * Turn-level assertion fields the executor enforces that a canned/echoing
 * reply cannot trivially satisfy. `responseIncludesAny` / `responseIncludesAll`
 * are deliberately absent: keyword-echo assertions are tracked (and only
 * allowed to shrink) by the scenario-runner echo-assertion guard.
 */
const LOAD_BEARING_TURN_FIELDS = [
  "assertTurn",
  "assertResponse",
  "expectedActions",
  "forbiddenActions",
  "plannerIncludesAll",
  "plannerIncludesAny",
  "plannerExcludes",
  "responseExcludes",
  "responseJudge",
] as const;

function hasLoadBearingAssertion(scenario: ScenarioDefinition): boolean {
  const finalChecks = (scenario as { finalChecks?: unknown[] }).finalChecks;
  if (Array.isArray(finalChecks) && finalChecks.length > 0) return true;
  return scenario.turns.some((turn) =>
    LOAD_BEARING_TURN_FIELDS.some(
      (field) => (turn as Record<string, unknown>)[field] !== undefined,
    ),
  );
}

async function loadCorpus(): Promise<
  Array<{ file: string; scenario: ScenarioDefinition }>
> {
  const files = await discoverScenarios(scenarioDir);
  return Promise.all(files.map((file) => loadScenarioFile(file)));
}

// Share module loading across the corpus checks.
const corpusPromise = loadCorpus();

describe("executive assistant scenario coverage", () => {
  it("every scenario file loads through the real scenario loader", async () => {
    const corpus = await corpusPromise;

    expect(corpus.length).toBeGreaterThan(0);

    // Unique ids, and each id matches its filename so `--filter <id>` and the
    // file on disk always agree.
    const ids = new Set<string>();
    for (const { file, scenario } of corpus) {
      expect(
        ids.has(scenario.id),
        `duplicate scenario id ${scenario.id} (${file})`,
      ).toBe(false);
      ids.add(scenario.id);
      expect(basename(file), `id/filename mismatch in ${file}`).toBe(
        `${scenario.id}.scenario.ts`,
      );
      expect(
        scenario.turns.length,
        `${scenario.id} has no turns — nothing to run`,
      ).toBeGreaterThan(0);
    }
  });

  it("every scenario carries at least one load-bearing assertion", async () => {
    const corpus = await corpusPromise;
    const vacuous = corpus
      .filter(({ scenario }) => !hasLoadBearingAssertion(scenario))
      .map(({ scenario }) => scenario.id);
    expect(
      vacuous,
      "scenarios with no enforceable assertion beyond keyword echo — add finalChecks, assertTurn, planner matchers, or expectedActions",
    ).toEqual([]);
  });
});
