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

type ConnectorCatalogScenario = {
  id: string;
  connector: string;
  providers: string[];
  actions: string[];
  capabilities: string[];
};

type ConnectorCatalog = {
  catalogId: string;
  scenarios: ConnectorCatalogScenario[];
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
  assertTurn?: unknown;
  responseIncludesAny?: Array<string | RegExp>;
  responseJudge?: { rubric: string; minimumScore?: number };
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
const CONNECTOR_SCENARIO_DIR = path.join(
  REPO_ROOT,
  "test",
  "scenarios",
  "connector-certification",
);
const CONNECTOR_CATALOG_PATH = path.join(
  REPO_ROOT,
  "test",
  "scenarios",
  "lifeops",
  "_catalogs",
  "lifeops-connector-certification.json",
);

const ACTION_SHAPE_CHECK_TYPES = new Set([
  "selectedAction",
  "selectedActionArguments",
  "actionCalled",
]);

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

async function loadCatalog(): Promise<ConnectorCatalog> {
  const raw = await readFile(CONNECTOR_CATALOG_PATH, "utf8");
  return JSON.parse(raw) as ConnectorCatalog;
}

async function loadScenario(id: string): Promise<TsScenario> {
  const module = await import(
    pathToFileURL(path.join(CONNECTOR_SCENARIO_DIR, `${id}.scenario.ts`)).href
  );
  return module.default as TsScenario;
}

function countCheckTypes(finalChecks: ScenarioFinalCheck[] | undefined): {
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

describe("LifeOps connector certification contracts", () => {
  it("keeps the connector certification catalog and scenario suite in lockstep", async () => {
    const [catalog, scenarioFiles] = await Promise.all([
      loadCatalog(),
      readdir(CONNECTOR_SCENARIO_DIR),
    ]);

    const fileIds = scenarioFiles
      .filter((entry) => entry.endsWith(".scenario.ts"))
      .map((entry) => entry.replace(/\.scenario\.ts$/u, ""))
      .sort();
    const catalogIds = catalog.scenarios.map((scenario) => scenario.id).sort();

    expect(catalog.catalogId).toBe("lifeops-connector-certification");
    expect(fileIds).toEqual(catalogIds);
  });

  it("keeps each certification scenario executable and connector-specific", async () => {
    const catalog = await loadCatalog();

    for (const entry of catalog.scenarios) {
      const scenario = await loadScenario(entry.id);
      const source = await readFile(
        path.join(CONNECTOR_SCENARIO_DIR, `${entry.id}.scenario.ts`),
        "utf8",
      );
      const firstTurn = scenario.turns[0];
      const customCheck = (scenario.finalChecks ?? []).find(
        (check) => check.type === "custom",
      );
      const dryRun = await customCheck?.predicate?.({
        actionsCalled: [],
        turns: [],
      });

      expect(scenario.id).toBe(entry.id);
      expect(scenario.domain).toBe("connector-certification");
      expect(scenario.tags).toEqual(
        expect.arrayContaining(["connector-certification", entry.connector]),
      );
      expect(firstTurn?.text?.length ?? 0).toBeGreaterThan(0);
      expect(typeof firstTurn?.assertTurn).toBe("function");
      expect(source).not.toContain("NotYetImplemented");
      expect(String(dryRun ?? "")).not.toContain("NotYetImplemented");
      expect(entry.providers.length).toBeGreaterThan(0);
      expect(entry.actions.length).toBeGreaterThan(0);
      expect(entry.capabilities.length).toBeGreaterThan(0);
    }
  });

  it("covers the required connector families from the PRD", async () => {
    const connectors = new Set(
      (await loadCatalog()).scenarios.map((scenario) => scenario.connector),
    );
    for (const connector of [
      "gmail",
      "google-calendar",
      "calendly",
      "discord",
      "telegram",
      "x-dm",
      "signal",
      "whatsapp",
      "imessage",
      "twilio-sms",
      "twilio-voice",
      "google-drive-docs-sheets",
      "travel-booking",
      "notifications",
      "browser-portal",
    ]) {
      expect(connectors.has(connector)).toBe(true);
    }
  });

  it("requires every connector certification scenario to assert action-shape, side-effect, and judge-rubric (WS8 triple)", async () => {
    const catalog = await loadCatalog();

    for (const entry of catalog.scenarios) {
      const scenario = await loadScenario(entry.id);
      const counts = countCheckTypes(scenario.finalChecks);

      expect(
        counts.actionShape,
        `${entry.id} must include at least one action-shape final check`,
      ).toBeGreaterThan(0);

      expect(
        counts.sideEffect,
        `${entry.id} must include at least one side-effect final check (connectorDispatchOccurred / messageDelivered / approvalRequestExists / draftExists / pushSent / etc.)`,
      ).toBeGreaterThan(0);

      const turnRubricCount = scenario.turns.filter(
        (turn) => turn.responseJudge !== undefined,
      ).length;
      expect(
        counts.rubric + turnRubricCount,
        `${entry.id} must include at least one rubric assertion (judgeRubric final check or responseJudge on a turn)`,
      ).toBeGreaterThan(0);
    }
  });
});
