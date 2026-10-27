/**
 * classifyToolOutput files each tool signal under test/build/lint/raw by its
 * runner markers, and the deterministic completion pre-pass reads only the
 * `test` bucket for a "tests pass" criterion. Transcripts are trimmed from
 * real non-TTY runs of vitest 5.0.3, bun test 1.4.2, tsc and biome.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { classifyToolOutput } from "../services/completion-evidence.ts";
import {
  deterministicLedgerVerdict,
  isGreenCheckOutput,
} from "../services/producible-evidence.ts";

const VITEST_GREEN = [
  "",
  " RUN  v5.0.3 /repo",
  "",
  "",
  " Test Files  1 passed (1)",
  "      Tests  3 passed (3)",
  "   Start at  09:25:35",
  "   Duration  156ms (transform 60%, import 27%, worker 8%, tests 5%)",
  "",
].join("\n");

const VITEST_RED = [
  " FAIL  src/math.test.ts > add > adds",
  "AssertionError: expected 3 to be 4 // Object.is equality",
  "",
  " Test Files  1 failed (1)",
  "      Tests  1 failed | 2 passed (3)",
].join("\n");

const BUN_TEST_GREEN = [
  "bun test v1.4.2 (744846f84)",
  "",
  " 1 pass",
  " 0 fail",
  " 1 expect() calls",
  "Ran 1 test across 1 file. [79.00ms]",
].join("\n");

const TSC_RED =
  "src/bad.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.";

const BIOME_RED = [
  "src/bad.ts:2:7 lint/suspicious/noDoubleEquals  FIXABLE  ━━━━━━━━━━",
  "",
  "  × Using == may be unsafe if you are relying on type coercion.",
].join("\n");

function testsPassVerdict(test: string | undefined) {
  return deterministicLedgerVerdict(["All tests pass"], {
    verifiedPublicUrls: [],
    ledgerVerifiedFiles: ["src/math.ts"],
    hasChangeSet: true,
    greenChecks: { test: isGreenCheckOutput(test), build: false, lint: false },
  }).results[0];
}

describe("classifyToolOutput test markers", () => {
  it.each(["bun run test", "npm test"])(
    "files a passing vitest run started with `%s` as test output",
    (source) => {
      const out = classifyToolOutput([{ text: VITEST_GREEN, source }]);
      expect(Object.keys(out ?? {})).toEqual(["test"]);
      expect(out?.test).toContain("Test Files  1 passed (1)");
      expect(testsPassVerdict(out?.test)).toEqual({
        criterion: "All tests pass",
        status: "met",
        basis: "green test output captured",
      });
    },
  );

  it("files a passing bun test run as test output", () => {
    const out = classifyToolOutput([
      { text: BUN_TEST_GREEN, source: "bun test" },
    ]);
    expect(Object.keys(out ?? {})).toEqual(["test"]);
    expect(testsPassVerdict(out?.test)?.status).toBe("met");
  });

  it("keeps a failing vitest run under test without settling the criterion", () => {
    const out = classifyToolOutput([
      { text: VITEST_RED, source: "bun run test" },
    ]);
    expect(Object.keys(out ?? {})).toEqual(["test"]);
    expect(testsPassVerdict(out?.test)?.status).toBe("undetermined");
  });

  it("keeps typecheck and lint diagnostics in their own buckets", () => {
    const out = classifyToolOutput([
      { text: TSC_RED, source: "bun run typecheck" },
      { text: BIOME_RED, source: "bun run lint" },
    ]);
    expect(out).toEqual({
      build: TSC_RED,
      lint: "src/bad.ts:2:7 lint/suspicious/noDoubleEquals  FIXABLE  ━━━━━━━━━━",
    });
  });

  it("does not take prose that says pass for a test run", () => {
    const out = classifyToolOutput([
      {
        text: "Requests pass through the proxy unchanged.",
        source: "cat docs/proxy.md",
      },
    ]);
    expect(Object.keys(out ?? {})).toEqual(["raw"]);
    expect(testsPassVerdict(out?.test)?.status).toBe("undetermined");
  });
});
