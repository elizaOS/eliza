import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_VIEW_LLM_MOCK_CASES,
  PLUGIN_VIEW_LLM_MOCK_JOURNEYS,
  type PluginViewMockCase,
} from "./view-user-journeys.js";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

function caseKey(view: Pick<PluginViewMockCase, "id" | "viewType" | "path">) {
  return `${view.id}:${view.viewType}:${view.path}`;
}

function isGuiOrTui(view: PluginViewMockCase) {
  return view.viewType === "gui" || view.viewType === "tui";
}

function readVisualMatrixCases(): PluginViewMockCase[] {
  const source = readFileSync(
    resolve(repoRoot, "packages/app/test/ui-smoke/plugin-view-cases.ts"),
    "utf8",
  );
  const match = source.match(
    /const VIEW_CASES: ViewCase\[] = \(?\s*\[([\s\S]*?)\]\s*(?:satisfies[\s\S]*?)?\)?\s*\.map/,
  );
  expect(match?.[1], "VIEW_CASES declaration was not found").toBeTruthy();
  const viewCasesSource = match?.[1] ?? "";

  return Array.from(
    viewCasesSource.matchAll(
      /\["([^"]+)",\s*"(gui|tui)",\s*"([^"]+)"(?:,\s*\{[^}]*\})?\]/g,
    ),
  ).flatMap((caseMatch) => {
    const id = caseMatch[1];
    const viewType = caseMatch[2];
    const path = caseMatch[3];
    if (!id || (viewType !== "gui" && viewType !== "tui") || !path) {
      return [];
    }
    return [{ id, viewType, path }];
  });
}

function readXrRatchetCases(): PluginViewMockCase[] {
  const source = readFileSync(
    resolve(repoRoot, "packages/app/test/route-coverage.test.ts"),
    "utf8",
  );
  const match = source.match(
    /const KNOWN_XR_VIEW_CASES: readonly PluginViewCase\[] = \[([\s\S]*?)\];/,
  );
  expect(
    match?.[1],
    "KNOWN_XR_VIEW_CASES declaration was not found",
  ).toBeTruthy();
  const xrCasesSource = match?.[1] ?? "";

  return Array.from(
    xrCasesSource.matchAll(
      /id:\s*"([^"]+)",\s*viewType:\s*"xr",\s*path:\s*"([^"]+)"/g,
    ),
  ).flatMap((caseMatch) => {
    const id = caseMatch[1];
    const path = caseMatch[2];
    if (!id || !path) return [];
    return [{ id, viewType: "xr", path }];
  });
}

describe("plugin view LLM mock coverage", () => {
  it("keeps mock LLM journeys in lockstep with the visual smoke matrix", () => {
    const visualCases = readVisualMatrixCases();
    const visualMockCases = PLUGIN_VIEW_LLM_MOCK_CASES.filter(isGuiOrTui);

    expect(visualCases.length).toBe(58);
    expect(new Set(visualCases.map(caseKey))).toEqual(
      new Set(visualMockCases.map(caseKey)),
    );
  });

  it("keeps XR mock LLM journeys in lockstep with the XR manifest ratchet", () => {
    const xrCases = readXrRatchetCases();
    const xrMockCases = PLUGIN_VIEW_LLM_MOCK_CASES.filter(
      (view) => view.viewType === "xr",
    );

    expect(xrCases.length).toBe(29);
    expect(new Set(xrCases.map(caseKey))).toEqual(
      new Set(xrMockCases.map(caseKey)),
    );
  });

  it("has one deterministic mock-eval journey for every plugin view case", () => {
    const visualCases = readVisualMatrixCases();
    const xrCases = readXrRatchetCases();
    const expectedCases = [...visualCases, ...xrCases];
    const journeyByKey = new Map(
      PLUGIN_VIEW_LLM_MOCK_JOURNEYS.map((journey) => [
        journey.id.replace(/^plugin-view-/, ""),
        journey,
      ]),
    );

    expect(PLUGIN_VIEW_LLM_MOCK_CASES.length).toBe(87);
    expect(PLUGIN_VIEW_LLM_MOCK_JOURNEYS).toHaveLength(
      PLUGIN_VIEW_LLM_MOCK_CASES.length,
    );

    for (const view of expectedCases) {
      const journey = journeyByKey.get(`${view.id}-${view.viewType}`);

      // Only the existence check has teeth here. The former `.toContain(view.path
      // / view.id / view.viewType)` assertions were tautological (#10718): the
      // journeys are built in view-user-journeys.ts by interpolating those very
      // fields into userMessage/expectedBehavior/verificationCriteria, so the
      // substring checks only confirmed JS template interpolation, never any
      // production routing. The count + lockstep + no-collision invariants above
      // carry the real coverage; live routing lives in view-llm-eval.test.ts.
      expect(journey, `missing mock journey for ${caseKey(view)}`).toBeTruthy();
    }
  });

  // NOTE (#10718 de-larp): a former sub-test here ran each journey through a
  // `mockLlmViewPlanner` defined in THIS file — a local longest-path string
  // matcher — and asserted it returned the case the same journey declared. That
  // was tautological: it exercised no production planning/routing/dispatch code,
  // only a hand-rolled matcher against strings the fixture itself constructed, so
  // it could never fail on a real planner regression. Actual planner routing
  // (userMessage → real model → view id → dispatch) is exercised against a live
  // Anthropic model in `view-llm-eval.test.ts` (`describe.skipIf(!hasCredential)`,
  // live lane). This file owns the deterministic PR-lane contract: the journey
  // corpus stays in lockstep with the visual + XR matrices (the tests above).
  //
  // The direct corpus-integrity property the live eval depends on: no two cases
  // share the same (viewType, path). A duplicate would make a "show me <path>"
  // prompt ambiguous — the model could open either view and the eval would
  // flake or wrongly fail. Asserted straight, not disguised as a re-implemented
  // router, so it fails only on a real authoring bug (a duplicated route).
  it("has no two view cases sharing the same (viewType, path)", () => {
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const view of PLUGIN_VIEW_LLM_MOCK_CASES) {
      const key = `${view.viewType}:${view.path}`;
      const prior = seen.get(key);
      if (prior) collisions.push(`${key} claimed by both "${prior}" and "${view.id}"`);
      else seen.set(key, view.id);
    }
    expect(collisions, collisions.join("; ")).toEqual([]);
  });
});
