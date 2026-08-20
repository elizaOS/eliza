/** Validates the catalog CLI config derives completeness from the canonical provider inventory. */

import { describe, expect, it } from "vitest";
import { PROVIDER_CANARY_SCENARIO_IDS } from "./canary-catalog.ts";
import {
  PROVIDER_QUALIFICATION_CATALOG_CONFIG_SCHEMA,
  parseProviderQualificationCatalogConfig,
} from "./qualification-cli.ts";

const REPOSITORY_SHA = "a".repeat(40);
const ARTIFACT_FILES = PROVIDER_CANARY_SCENARIO_IDS.map(
  (scenarioId) => `${scenarioId}/qualification.json`,
);

function config(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: PROVIDER_QUALIFICATION_CATALOG_CONFIG_SCHEMA,
    expectedRepositorySha: REPOSITORY_SHA,
    artifactFiles: ARTIFACT_FILES,
    outputDir: "catalog-output",
    ...overrides,
  };
}

describe("provider qualification catalog config", () => {
  it("accepts exactly 13 unique artifact files without caller-owned IDs", () => {
    const parsed = parseProviderQualificationCatalogConfig(config());
    expect(parsed.schema).toBe(
      "eliza.provider-qualification-catalog-config.v2",
    );
    expect(parsed.artifactFiles).toEqual(ARTIFACT_FILES);
    expect(parsed).not.toHaveProperty("expectedScenarioIds");
  });

  it("rejects caller-asserted inventory from the retired v1 shape", () => {
    expect(() =>
      parseProviderQualificationCatalogConfig(
        config({ expectedScenarioIds: PROVIDER_CANARY_SCENARIO_IDS }),
      ),
    ).toThrow(/closed shape.*expectedScenarioIds/);
    expect(() =>
      parseProviderQualificationCatalogConfig(
        config({ schema: "eliza.provider-qualification-catalog-config.v1" }),
      ),
    ).toThrow(/schema is unsupported/);
  });

  it("rejects partial, extra, and duplicate artifact-file inventories", () => {
    expect(() =>
      parseProviderQualificationCatalogConfig(
        config({ artifactFiles: ARTIFACT_FILES.slice(0, -1) }),
      ),
    ).toThrow(/exactly 13 unique/);
    expect(() =>
      parseProviderQualificationCatalogConfig(
        config({ artifactFiles: [...ARTIFACT_FILES, "extra.json"] }),
      ),
    ).toThrow(/exactly 13 unique/);
    expect(() =>
      parseProviderQualificationCatalogConfig(
        config({
          artifactFiles: [...ARTIFACT_FILES.slice(0, -1), ARTIFACT_FILES[0]],
        }),
      ),
    ).toThrow(/exactly 13 unique/);
  });
});
