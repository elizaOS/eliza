/**
 * Verifies the data-only provider inventory stays exact, ordered, and aligned
 * with authored canary files without evaluating their scenario modules.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadScenarioMetadataFile } from "../loader.ts";
import { PROVIDER_CANARY_SCENARIO_IDS } from "./canary-catalog.ts";

const PROVIDER_SCENARIO_DIRECTORY = fileURLToPath(
  new URL("../../../test/scenarios/provider-qualified/", import.meta.url),
);

describe("canonical provider canary inventory", () => {
  it("contains exactly 13 unique IDs in canonical lexical order", () => {
    expect(PROVIDER_CANARY_SCENARIO_IDS).toHaveLength(13);
    expect(new Set(PROVIDER_CANARY_SCENARIO_IDS).size).toBe(13);
    expect(PROVIDER_CANARY_SCENARIO_IDS).toEqual(
      [...PROVIDER_CANARY_SCENARIO_IDS].sort(),
    );
  });

  it("matches authored filenames and static IDs without importing them", async () => {
    const authoredFiles = readdirSync(PROVIDER_SCENARIO_DIRECTORY)
      .filter((file) => file.endsWith(".scenario.ts"))
      .sort();
    expect(
      authoredFiles.map((file) => path.basename(file, ".scenario.ts")),
    ).toEqual(PROVIDER_CANARY_SCENARIO_IDS);
    const metadata = await Promise.all(
      authoredFiles.map((file) =>
        loadScenarioMetadataFile(path.join(PROVIDER_SCENARIO_DIRECTORY, file)),
      ),
    );
    expect(metadata.map(({ id }) => id)).toEqual(PROVIDER_CANARY_SCENARIO_IDS);
  });
});
