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

      expect(journey, `missing mock journey for ${caseKey(view)}`).toBeTruthy();
      expect(journey?.userMessage).toContain(view.path);
      expect(journey?.expectedBehavior).toContain(`"${view.id}"`);
      expect(journey?.expectedBehavior).toContain(`"${view.viewType}"`);
      expect(journey?.verificationCriteria.join("\n")).toContain(view.path);
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
  // Below is a REAL corpus-quality guard the live eval depends on — that every
  // journey prompt is unambiguous, so a real longest-path router cannot resolve
  // it to a DIFFERENT view than the one it declares.
  it("every journey prompt unambiguously identifies its own view (no colliding paths)", () => {
    const casesByLongestPath = [...PLUGIN_VIEW_LLM_MOCK_CASES].sort(
      (left, right) => right.path.length - left.path.length,
    );
    for (const journey of PLUGIN_VIEW_LLM_MOCK_JOURNEYS) {
      const declared = PLUGIN_VIEW_LLM_MOCK_CASES.find(
        (view) =>
          journey.expectedBehavior.includes(`"${view.id}"`) &&
          journey.expectedBehavior.includes(`"${view.viewType}"`) &&
          journey.expectedBehavior.includes(`"${view.path}"`),
      );
      expect(declared, `missing case backing ${journey.id}`).toBeTruthy();

      // Resolve the prompt the way a deterministic longest-path router would,
      // honoring the modality the prompt names. `declared` comes from the
      // journey's expectedBehavior, `routed` from its userMessage — if they
      // diverge, two cases have colliding paths and the live eval would flake.
      const message = journey.userMessage.toLowerCase();
      const wantType = message.includes("spatial xr")
        ? "xr"
        : message.includes("terminal tui")
          ? "tui"
          : message.includes("visual gui")
            ? "gui"
            : null;
      const routed = casesByLongestPath.find(
        (view) =>
          (!wantType || view.viewType === wantType) &&
          message.includes(view.path.toLowerCase()),
      );
      expect(
        routed ? `${routed.id}-${routed.viewType}` : null,
        `journey ${journey.id}: prompt routes to ${routed?.id}-${routed?.viewType}, not its declared ${declared?.id}-${declared?.viewType} (ambiguous/colliding corpus prompt)`,
      ).toBe(`${declared?.id}-${declared?.viewType}`);
    }
  });
});
