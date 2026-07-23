/** Checks the Windows workflow's package-runner quarantine configuration. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const workflowText = readFileSync(
  new URL("../../../.github/workflows/windows-ci.yml", import.meta.url),
  "utf8",
);

describe("Windows CI workflow", () => {
  test("delegates the Windows PGlite quarantine to the package runner", () => {
    expect(workflowText).not.toContain("--path-ignore-patterns");
    expect(workflowText).not.toContain("Retry-isolated tenant-db PGlite suite");
    expect(workflowText).not.toContain(
      "bun run --cwd packages/cloud/shared test $suite",
    );
  });
});
