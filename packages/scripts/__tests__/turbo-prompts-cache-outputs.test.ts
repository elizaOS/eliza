// Exercises tests turbo prompts cache outputs.test automation behavior with deterministic script fixtures.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const turbo = JSON.parse(
  readFileSync(path.join(repoRoot, "turbo.json"), "utf8"),
);

describe("@elizaos/prompts Turbo build cache outputs", () => {
  test("restores generated artifacts and hashes scanned plugin sources", () => {
    const task = turbo.tasks["@elizaos/prompts#build"];
    const outputs = new Set(task.outputs ?? []);
    const inputs = new Set(task.inputs ?? []);
    const dependencies = new Set(task.dependsOn ?? []);

    expect(task.cache).not.toBe(false);
    expect(outputs.has("specs/actions/plugins.generated.json")).toBe(true);
    expect(
      outputs.has("$TURBO_ROOT$/packages/core/src/generated/action-docs.ts"),
    ).toBe(true);
    expect(inputs.has("$TURBO_ROOT$/plugins/**/*.ts")).toBe(true);
    // Prompts is an input to core, so making prompts wait on core creates a
    // build cycle and leaves its published dist entry absent in consumers.
    expect(dependencies.has("@elizaos/core#build")).toBe(false);
  });
});
