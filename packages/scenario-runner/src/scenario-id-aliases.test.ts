/** Verifies scenario aliases and removals retain checked replacement or source evidence. */

import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverScenarios,
  loadAllScenarios,
  loadScenarioFile,
} from "./loader.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const scenarioRoot = resolve(repoRoot, "packages/test/scenarios");
const aliasPath = resolve(scenarioRoot, "_scenario-id-aliases.json");
const retirementPath = resolve(scenarioRoot, "_scenario-retirements.json");

type Retirement =
  | { disposition: "renamed"; replacement: string }
  | {
      disposition: "covered-by";
      replacement: string;
      replacementPath: string;
    }
  | {
      disposition: "removed";
      sourceEvidence: string[];
      evidenceContains: string[];
    };

function readAliases(): Record<string, string> {
  return JSON.parse(readFileSync(aliasPath, "utf8")) as Record<string, string>;
}

function readRetirements(): Record<string, Retirement> {
  const parsed = JSON.parse(readFileSync(retirementPath, "utf8")) as {
    version: number;
    retirements: Record<string, Retirement>;
  };
  expect(parsed.version).toBe(1);
  return parsed.retirements;
}

describe("scenario ID aliases", () => {
  it("maps retired IDs to distinct live scenario IDs without chains or cycles", async () => {
    expect(existsSync(aliasPath)).toBe(true);
    const aliases = readAliases();
    const retirements = readRetirements();
    const scenarios = await Promise.all(
      (await discoverScenarios(scenarioRoot)).map(loadScenarioFile),
    );
    const liveIds = new Set(scenarios.map(({ scenario }) => scenario.id));

    expect(Object.keys(aliases).length).toBeGreaterThan(0);
    for (const [retiredId, replacementId] of Object.entries(aliases)) {
      expect(
        retirements[retiredId],
        `${retiredId} needs retirement metadata`,
      ).toEqual({
        disposition: "renamed",
        replacement: replacementId,
      });
      expect(retiredId).not.toBe(replacementId);
      expect(liveIds.has(retiredId), `${retiredId} must be retired`).toBe(
        false,
      );
      expect(
        liveIds.has(replacementId),
        `${retiredId} points to missing ${replacementId}`,
      ).toBe(true);
      expect(
        Object.hasOwn(aliases, replacementId),
        `${retiredId} must not point through an alias chain`,
      ).toBe(false);
    }
  });

  it("requires removed and covered claims to carry verifiable evidence", async () => {
    expect(existsSync(retirementPath)).toBe(true);
    const retirements = readRetirements();
    const scenarios = await Promise.all(
      (await discoverScenarios(scenarioRoot)).map(loadScenarioFile),
    );
    const liveIds = new Set(scenarios.map(({ scenario }) => scenario.id));

    for (const [retiredId, retirement] of Object.entries(retirements)) {
      expect(liveIds.has(retiredId), `${retiredId} must not remain live`).toBe(
        false,
      );
      if (retirement.disposition === "renamed") continue;

      if (retirement.disposition === "covered-by") {
        const replacementSource = readFileSync(
          resolve(repoRoot, retirement.replacementPath),
          "utf8",
        );
        expect(
          replacementSource.includes(retirement.replacement),
          `${retiredId} replacement source must declare ${retirement.replacement}`,
        ).toBe(true);
        continue;
      }

      expect(retirement.sourceEvidence.length, retiredId).toBeGreaterThan(0);
      expect(retirement.evidenceContains, retiredId).toHaveLength(
        retirement.sourceEvidence.length,
      );
      retirement.sourceEvidence.forEach((relativePath, index) => {
        const source = readFileSync(resolve(repoRoot, relativePath), "utf8");
        expect(
          source.includes(retirement.evidenceContains[index] ?? ""),
          `${retiredId} evidence missing from ${relativePath}`,
        ).toBe(true);
      });
    }
  });

  it("resolves a retired ID at the loader selection boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "scenario-alias-"));
    try {
      await writeFile(
        join(root, "_scenario-id-aliases.json"),
        JSON.stringify({ "retired.example": "live.example" }),
      );
      await writeFile(
        join(root, "live.scenario.ts"),
        `export default { id: "live.example", title: "Live", domain: "test", turns: [{ kind: "message", name: "ask", text: "Hello" }] };`,
      );
      const loaded = await loadAllScenarios(
        root,
        new Set(["retired.example"]),
        undefined,
        false,
      );
      expect(loaded.map(({ scenario }) => scenario.id)).toEqual([
        "live.example",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
