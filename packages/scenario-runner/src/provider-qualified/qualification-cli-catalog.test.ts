/** Validates the catalog CLI config derives completeness from the canonical provider inventory. */

import { describe, expect, it } from "vitest";
import { PROVIDER_CANARY_SCENARIO_IDS } from "./canary-catalog.ts";
import {
  PROVIDER_QUALIFICATION_CATALOG_CONFIG_SCHEMA,
  parseProviderQualificationCatalogConfig,
} from "./qualification-cli.ts";

const REPOSITORY_SHA = "a".repeat(40);
const PUBLICATION_FILES = PROVIDER_CANARY_SCENARIO_IDS.map(
  (scenarioId) => `${scenarioId}/publication.json`,
);

function config(overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: PROVIDER_QUALIFICATION_CATALOG_CONFIG_SCHEMA,
    expectedRepositorySha: REPOSITORY_SHA,
    publicationFiles: PUBLICATION_FILES,
    outputDir: "catalog-output",
    ...overrides,
  };
}

describe("provider qualification catalog config", () => {
  it("accepts exactly 13 unique publication capsules without caller-owned IDs", () => {
    const parsed = parseProviderQualificationCatalogConfig(config());
    expect(parsed.schema).toBe(
      "eliza.provider-qualification-catalog-config.v3",
    );
    expect(parsed.publicationFiles).toEqual(PUBLICATION_FILES);
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

  it("rejects raw artifacts and partial, extra, or duplicate publication inventories", () => {
    expect(() =>
      parseProviderQualificationCatalogConfig({
        ...(config() as Record<string, unknown>),
        publicationFiles: undefined,
        artifactFiles: PUBLICATION_FILES.map((file) =>
          file.replace("publication.json", "qualification.json"),
        ),
      }),
    ).toThrow(/closed shape/);
    expect(() =>
      parseProviderQualificationCatalogConfig(
        config({ publicationFiles: PUBLICATION_FILES.slice(0, -1) }),
      ),
    ).toThrow(/exactly 13 unique/);
    expect(() =>
      parseProviderQualificationCatalogConfig(
        config({ publicationFiles: [...PUBLICATION_FILES, "extra.json"] }),
      ),
    ).toThrow(/exactly 13 unique/);
    expect(() =>
      parseProviderQualificationCatalogConfig(
        config({
          publicationFiles: [
            ...PUBLICATION_FILES.slice(0, -1),
            PUBLICATION_FILES[0],
          ],
        }),
      ),
    ).toThrow(/exactly 13 unique/);
  });
});
