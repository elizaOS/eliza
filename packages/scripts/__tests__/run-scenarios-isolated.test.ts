/**
 * Regression coverage for the scenario isolation wrapper's repo-root path.
 *
 * Outside workspace test discovery - run via
 *   bun test packages/scripts/__tests__/run-scenarios-isolated.test.ts
 */
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

test("run-scenarios-isolated resolves the real scenario-runner CLI", () => {
  const result = spawnSync(
    "bun",
    ["packages/scripts/run-scenarios-isolated.mjs", "--print-paths"],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );

  expect(result.status).toBe(0);
  const paths = JSON.parse(result.stdout) as { repoRoot: string; cli: string };
  expect(paths.repoRoot).toBe(REPO_ROOT);
  expect(paths.cli).toBe(
    path.join(REPO_ROOT, "packages", "scenario-runner", "src", "cli.ts"),
  );
  expect(paths.cli).not.toContain("packages/eliza/packages");
  expect(existsSync(paths.cli)).toBe(true);
});
