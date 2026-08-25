/**
 * Keeps the deployed-renderer continuity proof wired to the shared composer
 * locator even though the opt-in Cloud smoke is outside the default typecheck.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const livenessContract = readFileSync(
  path.join(appDir, "test/liveness-contract.ts"),
  "utf8",
);
const cloudLiveSpec = readFileSync(
  path.join(appDir, "test/ui-smoke/cloud-live.spec.ts"),
  "utf8",
);

describe("Cloud live composer contract", () => {
  it("exports and imports the shared chat composer locator", () => {
    assert.match(
      livenessContract,
      /export function chatComposer\(page: Page\): Locator/,
    );
    const livenessImport = cloudLiveSpec.match(
      /import\s*\{([^}]*)\}\s*from "\.\.\/liveness-contract";/,
    );
    assert.ok(
      livenessImport,
      "Cloud live spec must import the liveness contract",
    );
    assert.match(livenessImport[1], /\bchatComposer\b/);
    assert.match(cloudLiveSpec, /await chatComposer\(page\)\.click\(\);/);
  });
});
