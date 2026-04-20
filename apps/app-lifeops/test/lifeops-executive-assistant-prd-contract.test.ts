/**
 * LINT-STYLE FIXTURE INVARIANTS (not a behavioral contract).
 *
 * Every assertion in this file checks the SHAPE of scenario/catalog
 * fixtures — not the BEHAVIOR of the scenarios themselves. It does not
 * execute any scenario. It does not call any LifeOps handler. A passing
 * run of this file only proves the fixtures have the right JSON shape
 * at the time the assertions ran.
 *
 * For real behavioral contract enforcement, co-locate behavioral tests
 * with the module they exercise and run them through the scenario
 * runner (see packages/scenario-runner/).
 *
 * Do NOT rename this to drop "contract" from the filename until the
 * tests actually enforce behavior — the grep history / imports across
 * the tree reference this filename. Renaming the describe() block is
 * allowed and preferred.
 */
import { readdir, readFile } from "node:fs/promises";
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

type ExecutiveAssistantCatalogScenario = {
  id: string;
  suite: string;
  examplePrompt: string;
  integrations: string[];
  providers: string[];
  actions: string[];
};

type ExecutiveAssistantCatalog = {
  catalogId: string;
  scenarios: ExecutiveAssistantCatalogScenario[];
};

type ScenarioFinalCheck = {
  type?: string;
  predicate?: (ctx: {
    actionsCalled: unknown[];
    turns?: unknown[];
    approvalRequests?: unknown[];
    connectorDispatches?: unknown[];
    memoryWrites?: unknown[];
    stateTransitions?: unknown[];
  }) => Promise<unknown> | unknown;
  [key: string]: unknown;
};

type ScenarioTurn = {
  text?: string;
  responseIncludesAny?: Array<string | RegExp>;
  responseJudge?: { rubric: string; minimumScore?: number };
  assertTurn?: (turn: { actionsCalled: unknown[] }) => Promise<unknown> | unknown;
  [key: string]: unknown;
};

type TsScenario = {
  id: string;
  domain: string;
  tags?: string[];
  turns: ScenarioTurn[];
  finalChecks?: ScenarioFinalCheck[];
};

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const EXECUTIVE_ASSISTANT_SCENARIO_DIR = path.join(
  REPO_ROOT,
  "test",
  "scenarios",
  "executive-assistant",
);
const EXECUTIVE_ASSISTANT_CATALOG_PATH = path.join(
  REPO_ROOT,
  "test",
  "scenarios",
  "lifeops",
  "_catalogs",
  "ice-bambam-executive-assistant.json",
);

/**
 * The check `type` strings that count as **action-shape** assertions.
 * These prove the agent invoked an action with the expected name (and
 * optionally the expected argument shape).
 */
const ACTION_SHAPE_CHECK_TYPES = new Set([
  "selectedAction",
  "selectedActionArguments",
  "actionCalled",
]);

/**
 * The check `type` strings that count as **side-effect** assertions.
 * These prove a real side effect occurred — a connector dispatched, a row
 * landed in the approval queue, a state machine moved, a draft was written,
 * a notification was delivered. Text-pattern assertions do not qualify.
 */
const SIDE_EFFECT_CHECK_TYPES = new Set([
  "approvalRequestExists",
  "approvalStateTransition",
  "noSideEffectOnReject",
  "draftExists",
  "messageDelivered",
  "pushSent",
  "pushEscalationOrder",
  "pushAcknowledgedSync",
  "interventionRequestExists",
  "browserTaskCompleted",
  "browserTaskNeedsHuman",
  "uploadedAssetExists",
  "connectorDispatchOccurred",
  "memoryWriteOccurred",
  "clarificationRequested",
]);

const RUBRIC_CHECK_TYPE = "judgeRubric";

function normalizeComparableText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sharesComparablePromptIntent(a: string, b: string): boolean {
  const aTokens = normalizeComparableText(a).split(/\s+/u).filter(Boolean);
  const bTokens = normalizeComparableText(b).split(/\s+/u).filter(Boolean);
  const bTokenSet = new Set(bTokens);
  let shared = 0;

  for (const token of aTokens) {
    if (bTokenSet.has(token)) {
      shared += 1;
    }
  }

  return shared >= 2;
}

async function loadCatalog(): Promise<ExecutiveAssistantCatalog> {
  const raw = await readFile(EXECUTIVE_ASSISTANT_CATALOG_PATH, "utf8");
  return JSON.parse(raw) as ExecutiveAssistantCatalog;
}

async function loadScenario(id: string): Promise<TsScenario> {
  const module = await import(
    pathToFileURL(
      path.join(EXECUTIVE_ASSISTANT_SCENARIO_DIR, `${id}.scenario.ts`),
    ).href
  );
  return module.default as TsScenario;
}

async function loadScenarioSource(id: string): Promise<string> {
  return readFile(
    path.join(EXECUTIVE_ASSISTANT_SCENARIO_DIR, `${id}.scenario.ts`),
    "utf8",
  );
}

function countCheckTypes(
  finalChecks: ScenarioFinalCheck[] | undefined,
): {
  actionShape: number;
  sideEffect: number;
  rubric: number;
} {
  const counts = { actionShape: 0, sideEffect: 0, rubric: 0 };
  for (const check of finalChecks ?? []) {
    const type = String(check.type ?? "");
    if (ACTION_SHAPE_CHECK_TYPES.has(type)) {
      counts.actionShape += 1;
    }
    if (SIDE_EFFECT_CHECK_TYPES.has(type)) {
      counts.sideEffect += 1;
    }
    if (type === RUBRIC_CHECK_TYPE) {
      counts.rubric += 1;
    }
  }
  return counts;
}

describe("LifeOps executive-assistant PRD fixture invariants (shape-only, not behavioral)", () => {
  it("keeps the transcript catalog and executable suite in lockstep", async () => {
    const [catalog, scenarioFiles] = await Promise.all([
      loadCatalog(),
      readdir(EXECUTIVE_ASSISTANT_SCENARIO_DIR),
    ]);

    const fileIds = scenarioFiles
      .filter((entry) => entry.endsWith(".scenario.ts"))
      .map((entry) => entry.replace(/\.scenario\.ts$/u, ""))
      .sort();
    const catalogIds = catalog.scenarios.map((scenario) => scenario.id).sort();

    expect(catalog.catalogId).toBe("ice-bambam-executive-assistant");
    expect(catalog.scenarios).toHaveLength(22);
    expect(new Set(catalogIds).size).toBe(catalogIds.length);
    expect(fileIds).toEqual(catalogIds);
  });

  it("keeps every transcript-derived scenario grounded in the catalog prompt and executable action checks", async () => {
    const catalog = await loadCatalog();

    for (const catalogScenario of catalog.scenarios) {
      const [scenario, scenarioSource] = await Promise.all([
        loadScenario(catalogScenario.id),
        loadScenarioSource(catalogScenario.id),
      ]);
      const tags = scenario.tags ?? [];
      const firstTurn = scenario.turns[0];
      const firstTurnText = String(firstTurn?.text ?? "");
      const firstCustomCheck = (scenario.finalChecks ?? []).find(
        (check) => check.type === "custom",
      );
      const firstCheckResult = await firstCustomCheck?.predicate?.({
        actionsCalled: [],
        turns: [],
      });

      expect(scenario.id).toBe(catalogScenario.id);
      expect(scenario.domain).toBe("executive-assistant");
      expect(tags).toEqual(
        expect.arrayContaining(["executive-assistant", "transcript-derived"]),
      );
      expect(firstTurnText.length).toBeGreaterThan(0);
      expect(
        sharesComparablePromptIntent(firstTurnText, catalogScenario.examplePrompt),
      ).toBe(true);
      expect(scenarioSource).not.toContain("NotYetImplemented");
      expect(typeof firstTurn?.assertTurn).toBe("function");
      expect(firstCustomCheck?.type).toBe("custom");
      expect(String(firstCheckResult ?? "")).not.toContain("NotYetImplemented");
      expect(catalogScenario.integrations.length).toBeGreaterThan(0);
      expect(catalogScenario.providers.length).toBeGreaterThan(0);
      expect(catalogScenario.actions.length).toBeGreaterThan(0);
    }
  });

  it("preserves the intended suite spread across the executive-assistant loop", async () => {
    const catalog = await loadCatalog();
    const suites = Array.from(
      new Set(catalog.scenarios.map((scenario) => scenario.suite)),
    ).sort();

    expect(suites).toEqual([
      "briefing",
      "calendar",
      "docs",
      "followup",
      "messaging",
      "push",
      "remote",
      "travel",
    ]);
  });

  it("keeps advanced runner assertions distributed across the transcript suite", async () => {
    const scenarios = await Promise.all(
      (await loadCatalog()).scenarios.map((entry) => loadScenario(entry.id)),
    );
    const finalCheckTypes = new Set(
      scenarios.flatMap((scenario) =>
        (scenario.finalChecks ?? []).map((check) => String(check.type ?? "")),
      ),
    );
    for (const type of [
      "selectedAction",
      "selectedActionArguments",
      "approvalRequestExists",
      "draftExists",
      "pushSent",
      "pushEscalationOrder",
      "pushAcknowledgedSync",
      "interventionRequestExists",
      "browserTaskCompleted",
      "uploadedAssetExists",
      // WS8 additions: every richer side-effect type must appear somewhere
      // in the suite so the runner has end-to-end coverage of each helper.
      "connectorDispatchOccurred",
      "memoryWriteOccurred",
      "approvalStateTransition",
      "noSideEffectOnReject",
      "judgeRubric",
    ]) {
      expect(finalCheckTypes.has(type)).toBe(true);
    }
  });

  it("requires every executive-assistant scenario to assert action-shape, side-effect, and judge-rubric (WS8 triple)", async () => {
    const catalog = await loadCatalog();

    for (const catalogScenario of catalog.scenarios) {
      const scenario = await loadScenario(catalogScenario.id);
      const counts = countCheckTypes(scenario.finalChecks);

      // (1) Action invocation shape — at least one final check that proves the
      // agent invoked the right action(s) with the right arguments.
      expect(
        counts.actionShape,
        `${catalogScenario.id} must include at least one action-shape final check (selectedAction / selectedActionArguments / actionCalled)`,
      ).toBeGreaterThan(0);

      // (2) Side effect — at least one final check that inspects a real
      // side effect (approval queue, dispatcher, memory, state machine).
      expect(
        counts.sideEffect,
        `${catalogScenario.id} must include at least one side-effect final check (approvalRequestExists / connectorDispatchOccurred / messageDelivered / pushSent / draftExists / interventionRequestExists / browserTaskCompleted / memoryWriteOccurred / etc.)`,
      ).toBeGreaterThan(0);

      // (3) LLM-judge rubric — at least one judgeRubric final check OR a
      // responseJudge on at least one turn. Either path satisfies the
      // rubric requirement; both is fine.
      const turnRubricCount = scenario.turns.filter(
        (turn) => turn.responseJudge !== undefined,
      ).length;
      expect(
        counts.rubric + turnRubricCount,
        `${catalogScenario.id} must include at least one rubric assertion (judgeRubric final check or responseJudge on a turn)`,
      ).toBeGreaterThan(0);

      // No scenario passes solely on a text pattern: at least one of the
      // turn assertions must be richer than just responseIncludesAny.
      const firstTurn = scenario.turns[0];
      const hasBehaviorAssertion =
        typeof firstTurn?.assertTurn === "function" ||
        firstTurn?.responseJudge !== undefined ||
        counts.actionShape + counts.sideEffect + counts.rubric > 0;
      expect(
        hasBehaviorAssertion,
        `${catalogScenario.id} must not pass on text patterns alone — provide assertTurn, responseJudge, or final-check coverage`,
      ).toBe(true);
    }
  });
});
