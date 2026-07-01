import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..", "..", "..");
const RUNNER = path.join(REPO_ROOT, "packages", "scripts", "run-all-tests.mjs");

function runRunner(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      TEST_LANE: "pr",
      TEST_PACKAGE_FILTER: "",
      TEST_SCRIPT_FILTER: "",
      TEST_SHARD: "",
      ...env,
    },
    encoding: "utf8",
  });

  return {
    ...result,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

describe("run-all-tests task plan mode", () => {
  test("help documents the list/dry-run option", () => {
    const result = runRunner(["--help"]);
    expect(result.status).toBe(0);
    expect(result.output).toContain("--list, --dry-run");
    expect(result.output).toContain("Print the discovered task plan");
  });

  test("--list prints discovered tasks without spawning test commands", () => {
    const result = runRunner(
      [
        "--list",
        "--filter=packages/core",
        "--only=test",
        "--no-cloud",
        "--concurrency=3",
      ],
      // If --list ever regresses and tries to prepare Postgres or spawn bun,
      // this stripped PATH makes the failure immediate and obvious.
      { PATH: "" },
    );

    expect(result.status).toBe(0);
    expect(result.output).toContain("[eliza-test] plan");
    expect(result.output).toContain("lane: pr");
    expect(result.output).toContain("scripts: test");
    expect(result.output).toContain("cloud: disabled");
    expect(result.output).toContain("concurrency: 3");
    expect(result.output).toContain("parallel task(s):");
    expect(result.output).toContain("serial task(s):");
    expect(result.output).toMatch(/@elizaos\/core \(packages\/core\)#test/);
    expect(result.output).not.toContain("[eliza-test] START");
    expect(result.output).not.toContain("[eliza-test] PASS");
  });

  test("--dry-run is an alias for the task plan path", () => {
    const result = runRunner([
      "--dry-run",
      "--filter=packages/core",
      "--only=test",
      "--no-cloud",
    ]);

    expect(result.status).toBe(0);
    expect(result.output).toContain("[eliza-test] plan");
    expect(result.output).not.toContain("[eliza-test] START");
  });
});
