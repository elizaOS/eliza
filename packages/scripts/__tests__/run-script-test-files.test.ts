/** Verifies the isolated script-test runner rejects invalid bounds before execution. */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildBunTestArgs,
  parseIsolatedScriptTestArgs,
  SCRIPT_TEST_TIMEOUT_MS,
} from "../run-script-test-files.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const driver = path.resolve(scriptDirectory, "..", "run-script-test-files.mjs");
const config = path.resolve(scriptDirectory, "..", "bunfig.script-tests.toml");
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

  test("passes the declared per-test timeout explicitly to every Bun child", () => {
    const options = parse();
    const args = buildBunTestArgs(testFile, options, "/tmp/result.xml");
    const configuredTimeout = Bun.TOML.parse(readFileSync(config, "utf8")).test
      ?.timeout;

    expect(SCRIPT_TEST_TIMEOUT_MS).toBe(configuredTimeout);
    expect(args).toContain("--timeout=60000");
    expect(args.indexOf("--timeout=60000")).toBeLessThan(
      args.indexOf(testFile),
    );
  });
});
