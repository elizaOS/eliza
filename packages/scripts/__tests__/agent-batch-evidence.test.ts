/**
 * Exercises the real agent batch wrapper through the repository evidence guard
 * using isolated temporary workspaces and actual Vitest testcase execution.
 */
import { expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const root = fileURLToPath(new URL("../../..", import.meta.url));

function runFixture(mode: "mixed" | "skipped" | "failed") {
  const directory = mkdtempSync(
    path.join(root, "packages", "agent-evidence-fixture-"),
  );
  const name = `@elizaos/${path.basename(directory)}`;
  try {
    for (const child of ["src", "test", "scripts"]) {
      mkdirSync(path.join(directory, child));
    }
    copyFileSync(
      path.join(root, "packages/agent/scripts/run-vitest-batches.mjs"),
      path.join(directory, "scripts/run-vitest-batches.mjs"),
    );
    writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({
        name,
        private: true,
        type: "module",
        scripts: { test: "node scripts/run-vitest-batches.mjs" },
      }),
    );
    writeFileSync(
      path.join(directory, "vitest.config.ts"),
      'export default { test: { include: ["src/*.test.ts"], maxWorkers: 1 } };\n',
    );
    writeFileSync(
      path.join(directory, "src/first.test.ts"),
      `import { test, expect } from "vitest";\n${mode === "skipped" ? "test.skip" : "test"}("executes arithmetic", () => expect(2 + 2).toBe(${mode === "failed" ? "5" : "4"}));\n`,
    );
    writeFileSync(
      path.join(directory, "src/second.test.ts"),
      'import { test } from "vitest";\ntest.skip("explicit unavailable fixture", () => { throw new Error("must stay skipped"); });\n',
    );
    return spawnSync(
      process.execPath,
      [
        path.join(root, "packages/scripts/run-all-tests.mjs"),
        "--only=test",
        "--no-cloud",
        `--filter=${name}`,
        "--require-work",
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: {
          ...process.env,
          AGENT_TEST_CONCURRENCY: "1",
          AGENT_TEST_BATCH_SIZE: "1",
        },
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("reconciles actual Vitest batches including skipped cases", () => {
  const result = runFixture("mixed");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toContain(
    "EVIDENCE reports=1 tests=2 executed=1 skipped=1 unobserved-tasks=0",
  );
}, 60_000);

test("all-skipped Vitest batches cannot satisfy required work", () => {
  const result = runFixture("skipped");
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(3);
  const record = result.stdout
    .split("\n")
    .find((line) => line.startsWith("[eliza-test] RESULT "));
  if (!record)
    throw new Error("Required-work runner emitted no testcase result.");
  const observed = JSON.parse(record.slice("[eliza-test] RESULT ".length));
  expect(observed.status).toBe("skip");
  expect(observed.observed).toBe(true);
  expect(observed.counts).toEqual({
    tests: 2,
    executed: 0,
    failures: 0,
    errors: 0,
    skipped: 2,
  });
}, 60_000);

test("a failed Vitest batch remains a failure", () => {
  const result = runFixture("failed");
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stdout).toContain("executes arithmetic");
  expect(result.stdout).toContain('"status":"fail"');
}, 60_000);
