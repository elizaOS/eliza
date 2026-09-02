/** Verifies the isolated script-test runner rejects invalid bounds before execution. */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseIsolatedScriptTestArgs } from "../run-script-test-files.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const driver = path.resolve(scriptDirectory, "..", "run-script-test-files.mjs");
const testFile = "packages/scripts/example.test.ts";

function parse(...options: string[]) {
  return parseIsolatedScriptTestArgs([...options, "--", testFile]);
}

describe("isolated script-test runner arguments", () => {
  test("preserves defaults and accepts the exact numeric ceilings", () => {
    expect(parse()).toMatchObject({ concurrency: 4, timeoutMs: 120_000 });
    expect(parse(`--concurrency=${Number.MAX_SAFE_INTEGER}`)).toMatchObject({
      concurrency: Number.MAX_SAFE_INTEGER,
    });
    expect(parse("--timeout-ms=2147483647")).toMatchObject({
      timeoutMs: 2_147_483_647,
    });
  });

  test.each(["0", "-1", "+1", "1.5", "1e3", "NaN", "Infinity", ""])(
    "rejects malformed positive integer %p",
    (value) => {
      expect(() => parse(`--concurrency=${value}`)).toThrow(
        "--concurrency requires a positive integer",
      );
      expect(() => parse(`--timeout-ms=${value}`)).toThrow(
        "--timeout-ms requires a positive integer",
      );
    },
  );

  test("rejects unsafe concurrency instead of rounding or accepting Infinity", () => {
    for (const value of ["9007199254740992", "9".repeat(400)]) {
      expect(() => parse(`--concurrency=${value}`)).toThrow(
        "--concurrency requires a positive safe integer",
      );
    }
  });

  test("rejects timeout values that Node would clamp to one millisecond", () => {
    for (const value of ["2147483648", "9007199254740992", "9".repeat(400)]) {
      expect(() => parse(`--timeout-ms=${value}`)).toThrow(
        "--timeout-ms requires a positive integer no greater than 2147483647",
      );
    }
  });

  test("the CLI rejects an overflowing timeout before starting a Bun child", () => {
    const result = spawnSync(
      process.execPath,
      [driver, "--timeout-ms=2147483648", "--", testFile],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "--timeout-ms requires a positive integer no greater than 2147483647",
    );
    expect(result.stderr).not.toContain("timed out");
    expect(result.stderr).not.toContain("TimeoutOverflowWarning");
  });

  test("the CLI names a failing test file", () => {
    const missingTestFile = "packages/scripts/__tests__/missing-script-test.ts";
    const result = spawnSync(
      process.execPath,
      [driver, "--concurrency=1", "--", missingTestFile],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `[script-tests] failed: ${missingTestFile} (exit 1)`,
    );
  });
});
