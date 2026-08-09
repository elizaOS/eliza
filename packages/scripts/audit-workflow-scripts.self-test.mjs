/**
 * Self-test for audit-workflow-scripts.mjs. Builds throwaway fixture trees and
 * verifies the contract catches a workflow `bun run` reference to a missing
 * root package.json script (the #18090 regression scenario).
 *
 * The contract MUST:
 *   1. Pass when all workflow script references resolve to root package.json.
 *   2. FAIL when a workflow references a nonexistent root script.
 *   3. SKIP steps with a working-directory (sub-package scripts, not root).
 *   4. Parse ci.yaml (the file ci-workflow-invariants.mjs does not load).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("./audit-workflow-scripts.mjs", import.meta.url),
);

function makeFixture(name) {
  const dir = mkdtempSync(join(tmpdir(), `audit-workflow-${name}-`));
  mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-repo",
      scripts: {
        build: "tsc",
        test: "vitest run",
        "clean:stale-js": "echo removed",
        verify: "bun run build && bun run test",
      },
    }),
  );
  return dir;
}

function runAudit(dir) {
  try {
    const stdout = execFileSync("node", [script, "--root", dir], {
      encoding: "utf8",
      timeout: 15000,
    });
    return { exitCode: 0, stdout };
  } catch (error) {
    return {
      exitCode: error.status ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    };
  }
}

// Test 1: All references resolve — should pass.
{
  const dir = makeFixture("clean");
  writeFileSync(
    join(dir, ".github", "workflows", "ci.yaml"),
    [
      "name: CI",
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bun install",
      "      - run: bun run build",
      "      - run: bun run test",
      "  verify:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bun run verify",
    ].join("\n"),
  );

  const result = runAudit(dir);
  if (result.exitCode !== 0) {
    throw new Error(
      `Test 1 (clean) should pass but failed: ${result.stderr || result.stdout}`,
    );
  }
  console.log("Test 1 (clean repo passes): OK");
}

// Test 2: Missing script reference — should FAIL.
{
  const dir = makeFixture("missing");
  writeFileSync(
    join(dir, ".github", "workflows", "ci.yaml"),
    [
      "name: CI",
      "on: [push]",
      "jobs:",
      "  dev-startup:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bun install",
      "      - run: bun run clean:stale-js",
    ].join("\n"),
  );
  // Remove the clean:stale-js script to simulate #18090.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "test-repo",
      scripts: {
        build: "tsc",
        test: "vitest run",
        verify: "bun run build && bun run test",
      },
    }),
  );

  const result = runAudit(dir);
  if (result.exitCode === 0) {
    throw new Error(
      "Test 2 (missing script) should FAIL but passed — contract has no teeth!",
    );
  }
  if (!result.stderr.includes("clean:stale-js")) {
    throw new Error(
      `Test 2 (missing script) failed but did not mention clean:stale-js: ${result.stderr}`,
    );
  }
  console.log("Test 2 (missing script detected): OK");
}

// Test 3: Steps with working-directory are skipped (sub-package scripts).
{
  const dir = makeFixture("workdir");
  writeFileSync(
    join(dir, ".github", "workflows", "test.yml"),
    [
      "name: Test",
      "on: [push]",
      "jobs:",
      "  test:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bun install",
      "      - run: bun run local-only-script",
      "        working-directory: packages/app",
    ].join("\n"),
  );

  const result = runAudit(dir);
  if (result.exitCode !== 0) {
    throw new Error(
      `Test 3 (workdir skip) should pass but failed: ${result.stderr || result.stdout}`,
    );
  }
  console.log("Test 3 (working-directory steps skipped): OK");
}

// Test 4: Chained commands — bun run A && bun run B.
{
  const dir = makeFixture("chained");
  writeFileSync(
    join(dir, ".github", "workflows", "ci.yaml"),
    [
      "name: CI",
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: bun run build && bun run test",
    ].join("\n"),
  );

  const result = runAudit(dir);
  if (result.exitCode !== 0) {
    throw new Error(
      `Test 4 (chained) should pass but failed: ${result.stderr || result.stdout}`,
    );
  }
  console.log("Test 4 (chained commands parsed): OK");
}

// Test 5: yarn bare invocation (yarn <name>, not yarn run <name>).
{
  const dir = makeFixture("yarn");
  writeFileSync(
    join(dir, ".github", "workflows", "ci.yaml"),
    [
      "name: CI",
      "on: [push]",
      "jobs:",
      "  build:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - run: yarn build",
      "      - run: yarn test",
    ].join("\n"),
  );

  const result = runAudit(dir);
  if (result.exitCode !== 0) {
    throw new Error(
      `Test 5 (yarn bare) should pass but failed: ${result.stderr || result.stdout}`,
    );
  }
  console.log("Test 5 (yarn bare invocations): OK");
}

console.log("\naudit-workflow-scripts self-test passed");
