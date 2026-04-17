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

type TsScenario = {
  id: string;
  domain: string;
  tags?: string[];
  turns: Array<{
    text?: string;
    responseIncludesAny?: Array<string | RegExp>;
    [key: string]: unknown;
  }>;
  finalChecks?: Array<{
    type?: string;
    predicate?: (ctx: { actionsCalled: unknown[] }) => Promise<unknown> | unknown;
    [key: string]: unknown;
  }>;
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

describe("LifeOps executive-assistant transcript contracts", () => {
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

  it("keeps every transcript-derived scenario grounded in the catalog prompt and explicit gaps", async () => {
    const catalog = await loadCatalog();

    for (const catalogScenario of catalog.scenarios) {
      const scenario = await loadScenario(catalogScenario.id);
      const tags = scenario.tags ?? [];
      const firstTurn = scenario.turns[0];
      const firstTurnText = String(firstTurn?.text ?? "");
      const firstCheck = scenario.finalChecks?.[0];
      const firstCheckResult = await firstCheck?.predicate?.({
        actionsCalled: [],
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
      expect(firstTurn?.responseIncludesAny?.length ?? 0).toBeGreaterThan(0);
      expect(firstCheck?.type).toBe("custom");
      expect(String(firstCheckResult ?? "")).toContain("NotYetImplemented");
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
});
