/**
 * Prevents completed repository policy gates from returning to root scripts or
 * GitHub Actions while preserving the ordinary build, test, and security gates.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const retiredStems = [
  "type-safety",
  "error-policy",
  "voice-policy",
  "view-action",
].map((policy) => `${policy}-ratchet`);

describe("retired repository policy gates", () => {
  test("stay absent from root scripts and workflows", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const rootScripts = Object.entries(packageJson.scripts ?? {})
      .map(([name, command]) => `${name}\n${command}`)
      .join("\n");

    const workflowsDir = path.join(repoRoot, ".github/workflows");
    const workflows = readdirSync(workflowsDir)
      .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
      .map((file) => readFileSync(path.join(workflowsDir, file), "utf8"))
      .join("\n");

    for (const stem of retiredStems) {
      expect(rootScripts).not.toContain(stem);
      expect(workflows).not.toContain(stem);
      expect(
        existsSync(path.join(repoRoot, "packages/scripts", `${stem}.mjs`)),
      ).toBe(false);
    }

    expect(
      existsSync(
        path.join(
          repoRoot,
          "packages/scripts",
          `${retiredStems[0]}-baseline.json`,
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          repoRoot,
          "packages/scripts",
          `${retiredStems[3]}.registry.json`,
        ),
      ),
    ).toBe(false);
  });

  test("root verification retains standard engineering gates", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const verify = packageJson.scripts?.verify;

    expect(verify).toContain("run-turbo.mjs run typecheck lint:check");
    expect(verify).toContain("audit:tee-secret-leak");
    expect(verify).toContain("audit:test-realness");
  });
});
