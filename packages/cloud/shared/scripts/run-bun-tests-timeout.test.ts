/** Verifies package-level timeout injection without crossing a process boundary. */
import { describe, expect, test } from "bun:test";
import { DEFAULT_TEST_TIMEOUT_MS, withDefaultTestTimeout } from "./run-bun-tests-helpers.mjs";

describe("cloud-shared Bun test timeout arguments", () => {
  test("defaults to 60s and preserves both caller forms", () => {
    const separated = ["--timeout", "120000", "src/example.test.ts"];
    const equals = ["--timeout=120000", "src/example.test.ts"];

    expect(withDefaultTestTimeout([])).toEqual([`--timeout=${DEFAULT_TEST_TIMEOUT_MS}`]);
    expect(withDefaultTestTimeout(["src/example.test.ts"])).toEqual([
      `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`,
      "src/example.test.ts",
    ]);
    expect(withDefaultTestTimeout(separated)).toEqual(separated);
    expect(withDefaultTestTimeout(equals)).toEqual(equals);
  });

  test("detection is fail-closed at Bun's option boundary", () => {
    expect(withDefaultTestTimeout(["--timeout"])).toEqual(["--timeout"]);
    expect(withDefaultTestTimeout(["--", "--timeout=120000"])).toEqual([
      `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`,
      "--",
      "--timeout=120000",
    ]);
    expect(withDefaultTestTimeout(["--timeout-report=120000"])).toEqual([
      `--timeout=${DEFAULT_TEST_TIMEOUT_MS}`,
      "--timeout-report=120000",
    ]);
  });
});
