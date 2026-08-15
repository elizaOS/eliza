/**
 * Runs the real package-test orchestrator against a temporary failing workspace
 * to verify its parallel capture path exposes truncation and every failed file.
 */
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const runner = fileURLToPath(new URL("../run-all-tests.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const fixtureDir = join(
  repoRoot,
  "packages",
  "__run_all_tests_captured_output_fixture__",
);

test("parallel package failures retain a complete file inventory after truncation", () => {
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });
  try {
    writeFileSync(
      join(fixtureDir, "package.json"),
      `${JSON.stringify(
        {
          name: "@elizaos/run-all-tests-captured-output-fixture",
          private: true,
          type: "module",
          scripts: { test: "node fail.mjs" },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(
      join(fixtureDir, "fail.mjs"),
      [
        'process.stdout.write(" FAIL  src/early.test.ts > early case\\n");',
        'process.stdout.write("x".repeat(17_000));',
        'process.stdout.write("\\n FAIL  src/late.spec.tsx > late case\\n");',
        "process.exitCode = 1;",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      [
        runner,
        "--only=test",
        "--no-cloud",
        "--concurrency=2",
        "--filter=@elizaos/run-all-tests-captured-output-fixture",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        env: process.env,
      },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

    expect(result.status).toBe(1);
    expect(output).toMatch(
      /TRUNCATED \d+ earlier character\(s\) omitted; 1 earlier failing test file\(s\) omitted/,
    );
    expect(output).toContain("[eliza-test] FAILING_FILE src/early.test.ts");
    expect(output).toContain("[eliza-test] FAILING_FILE src/late.spec.tsx");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});
