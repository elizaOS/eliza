/**
 * Verifies clean production renderer builds compile workspace dependencies
 * whose package exports intentionally resolve through dist.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPackage = JSON.parse(
  readFileSync(path.join(appDir, "package.json"), "utf8"),
);

describe("web build workspace dependencies", () => {
  it("builds the Cloud SDK before preparing the renderer", () => {
    assert.equal(
      appPackage.scripts["prebuild:web"],
      "bun run --cwd ../cloud/sdk build && bun run prebuild",
    );
  });
});
