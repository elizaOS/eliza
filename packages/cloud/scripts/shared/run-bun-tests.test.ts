import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { runCommandWithWatchdog } from "../../../scripts/test-cloud-run.ts";
import { supervisedBunExitStatus } from "./run-bun-tests-helpers.ts";

const directory = mkdtempSync(join(tmpdir(), "cloud-test-runner-"));
const probe = join(directory, "child.mjs");
writeFileSync(
  probe,
  "console.log(JSON.stringify(process.argv.slice(2))); process.exit(Number(process.env.PROBE_EXIT));",
);
afterAll(() => rmSync(directory, { recursive: true, force: true }));

for (const exitCode of [0, 7]) {
  test(`shared runner forwards exact arguments and exit ${exitCode}`, () => {
    const result = spawnSync(
      "node",
      [
        fileURLToPath(new URL("./run-bun-tests.ts", import.meta.url)),
        "./fixture with spaces.test.ts",
        "--timeout",
        "1234",
      ],
      {
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...process.env,
          ELIZA_BUN_TEST_BIN: "node",
          ELIZA_BUN_TEST_BIN_ARGS: JSON.stringify([probe]),
          ELIZA_WIN_PGLITE_QUARANTINE: "0",
          ELIZA_BUN_TEST_SHARDING: "0",
          PROBE_EXIT: String(exitCode),
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(exitCode);
    expect(result.stdout).toContain(
      JSON.stringify([
        "test",
        "--isolate",
        "./fixture with spaces.test.ts",
        "--timeout",
        "1234",
      ]),
    );
  });
}

test("watchdog termination cannot become a green test result through exit zero", async () => {
  const result = await runCommandWithWatchdog(
    "node",
    [
      "-e",
      "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 100);",
    ],
    { timeoutMs: 1000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.terminationError).toBeUndefined();
  expect(result.timedOut).toBe(true);
  expect(supervisedBunExitStatus(result)).toBe(124);
  expect(supervisedBunExitStatus({ ...result, status: 0, signal: null })).toBe(
    124,
  );
});
