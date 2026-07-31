/**
 * Regression coverage for the scenario isolation wrapper's repo-root path.
 *
 * Outside workspace test discovery - run via
 *   bun test packages/scripts/__tests__/run-scenarios-isolated.test.ts
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");

test("run-scenarios-isolated resolves the real scenario-runner CLI", () => {
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "packages/scripts/run-scenarios-isolated.mjs",
      "--print-paths",
    ],
    cwd: REPO_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });

  expect(result.exitCode).toBe(0);
  const cli = path.join(
    REPO_ROOT,
    "packages",
    "scenario-runner",
    "src",
    "cli.ts",
  );
  expect(cli).not.toContain("packages/eliza/packages");
  expect(existsSync(cli)).toBe(true);
});

test("run-scenarios-isolated terminates a child that exceeds its deadline", () => {
  const fixtureDir = mkdtempSync(
    path.join(os.tmpdir(), "scenario-process-timeout-"),
  );
  try {
    writeFileSync(
      path.join(fixtureDir, "timeout.scenario.ts"),
      `export default {
        id: "isolated-timeout",
        title: "isolated timeout",
        domain: "test",
        turns: [],
      };\n`,
    );
    const startedAt = Date.now();
    const result = Bun.spawnSync({
      cmd: [
        "bun",
        "packages/scripts/run-scenarios-isolated.mjs",
        fixtureDir,
        "--scenario-timeout-ms",
        "1",
      ],
      cwd: REPO_ROOT,
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
