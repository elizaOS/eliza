/**
 * Focused coverage for CDN validation retry-policy env parsing: unit contract
 * plus a real CLI boundary that rejects malformed overrides before root I/O.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CI_RETRY_POLICY,
  DEFAULT_LOCAL_RETRY_POLICY,
  getValidationRetryPolicy,
  parseNonNegativeSafeInteger,
  parsePositiveSafeInteger,
} from "./validate-cdn-assets.mjs";

const SCRIPT = fileURLToPath(
  new URL("./validate-cdn-assets.mjs", import.meta.url),
);
const MISSING_ROOT = path.join(
  path.dirname(SCRIPT),
  "__missing_cdn_root_for_policy_validation__",
);

function runCli(env = {}) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      // Clear policy knobs unless the test injects them.
      ELIZA_CDN_VALIDATE_ATTEMPTS: undefined,
      ELIZA_CDN_VALIDATE_DELAY_MS: undefined,
      ELIZA_CDN_VALIDATE_CONCURRENCY: undefined,
      ELIZA_CDN_ROOT_DIR: undefined,
      CI: undefined,
      ...env,
    },
    timeout: 15_000,
  });
}

describe("parsePositiveSafeInteger", () => {
  it("accepts positive safe integers as strings and numbers", () => {
    expect(parsePositiveSafeInteger("1", "label")).toBe(1);
    expect(parsePositiveSafeInteger("120", "label")).toBe(120);
    expect(parsePositiveSafeInteger(4, "label")).toBe(4);
    expect(parsePositiveSafeInteger(" 3 ", "label")).toBe(3);
  });

  it("rejects zero, negative, partial, signed, fractional, and non-decimal forms", () => {
    const bad = [
      "0",
      "-1",
      "1.5",
      "1junk",
      "+2",
      "0x10",
      "1e2",
      "012",
      "",
      " ",
      "NaN",
      "Infinity",
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -3,
      0,
      1.5,
    ];
    for (const value of bad) {
      expect(() => parsePositiveSafeInteger(value, "label")).toThrow(
        /must be a positive safe-integer decimal/,
      );
    }
  });
});

describe("parseNonNegativeSafeInteger", () => {
  it("accepts zero and positive safe integers", () => {
    expect(parseNonNegativeSafeInteger("0", "label")).toBe(0);
    expect(parseNonNegativeSafeInteger(0, "label")).toBe(0);
    expect(parseNonNegativeSafeInteger("5000", "label")).toBe(5000);
    expect(parseNonNegativeSafeInteger(" 10 ", "label")).toBe(10);
  });

  it("rejects negative, partial, signed, fractional, and non-decimal forms", () => {
    const bad = [
      "-1",
      "1.5",
      "1junk",
      "+0",
      "0x10",
      "1e2",
      "00",
      "012",
      "",
      " ",
      "NaN",
      Number.NaN,
      -1,
      1.5,
    ];
    for (const value of bad) {
      expect(() => parseNonNegativeSafeInteger(value, "label")).toThrow(
        /must be a non-negative safe-integer decimal/,
      );
    }
  });
});

describe("getValidationRetryPolicy", () => {
  it("uses local defaults when unset or empty outside CI", () => {
    expect(getValidationRetryPolicy({ env: {} })).toEqual(
      DEFAULT_LOCAL_RETRY_POLICY,
    );
    expect(
      getValidationRetryPolicy({
        env: {
          ELIZA_CDN_VALIDATE_ATTEMPTS: "",
          ELIZA_CDN_VALIDATE_DELAY_MS: "   ",
          ELIZA_CDN_VALIDATE_CONCURRENCY: "",
        },
      }),
    ).toEqual(DEFAULT_LOCAL_RETRY_POLICY);
  });

  it("uses CI defaults when CI=true and overrides are unset", () => {
    expect(getValidationRetryPolicy({ env: { CI: "true" } })).toEqual(
      DEFAULT_CI_RETRY_POLICY,
    );
  });

  it("accepts valid explicit overrides", () => {
    expect(
      getValidationRetryPolicy({
        env: {
          ELIZA_CDN_VALIDATE_ATTEMPTS: "5",
          ELIZA_CDN_VALIDATE_DELAY_MS: "0",
          ELIZA_CDN_VALIDATE_CONCURRENCY: "8",
        },
      }),
    ).toEqual({ attempts: 5, delayMs: 0, concurrency: 8 });
  });

  it("fails closed on explicit invalid env values", () => {
    expect(() =>
      getValidationRetryPolicy({
        env: { ELIZA_CDN_VALIDATE_ATTEMPTS: "1junk" },
      }),
    ).toThrow(
      /ELIZA_CDN_VALIDATE_ATTEMPTS must be a positive safe-integer decimal/,
    );

    expect(() =>
      getValidationRetryPolicy({
        env: { ELIZA_CDN_VALIDATE_DELAY_MS: "1.5" },
      }),
    ).toThrow(
      /ELIZA_CDN_VALIDATE_DELAY_MS must be a non-negative safe-integer decimal/,
    );

    expect(() =>
      getValidationRetryPolicy({
        env: { ELIZA_CDN_VALIDATE_CONCURRENCY: "+2" },
      }),
    ).toThrow(
      /ELIZA_CDN_VALIDATE_CONCURRENCY must be a positive safe-integer decimal/,
    );

    expect(() =>
      getValidationRetryPolicy({
        env: { ELIZA_CDN_VALIDATE_ATTEMPTS: "0" },
      }),
    ).toThrow(
      /ELIZA_CDN_VALIDATE_ATTEMPTS must be a positive safe-integer decimal/,
    );
  });
});

describe("validate-cdn-assets CLI boundary", () => {
  it("rejects malformed retry policy before inspecting a missing root", () => {
    for (const [key, value] of [
      ["ELIZA_CDN_VALIDATE_ATTEMPTS", "1junk"],
      ["ELIZA_CDN_VALIDATE_DELAY_MS", "1.5"],
      ["ELIZA_CDN_VALIDATE_CONCURRENCY", "+2"],
      ["ELIZA_CDN_VALIDATE_ATTEMPTS", "0"],
    ]) {
      const result = runCli({
        [key]: value,
        ELIZA_CDN_ROOT_DIR: MISSING_ROOT,
      });
      expect(result.status, `${key}=${value}`).not.toBe(0);
      const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(combined).toMatch(new RegExp(key));
      expect(combined).toMatch(/safe-integer decimal/);
      // Must not proceed into manifest / missing-root diagnostics.
      expect(combined).not.toMatch(/Static asset manifest/i);
      expect(combined).not.toMatch(/missing CDN files/i);
      expect(combined).not.toMatch(/ENOENT/i);
      expect(combined).not.toMatch(/verified \d+ managed asset/i);
    }
  });

  it("does not treat a missing root as success when policy is valid", () => {
    const result = runCli({
      ELIZA_CDN_VALIDATE_ATTEMPTS: "1",
      ELIZA_CDN_VALIDATE_DELAY_MS: "0",
      ELIZA_CDN_VALIDATE_CONCURRENCY: "1",
      ELIZA_CDN_ROOT_DIR: MISSING_ROOT,
    });
    expect(result.status).not.toBe(0);
    const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    // With a valid policy, main proceeds and fails later (missing root has no
    // git SHA / release tag and no static asset manifest).
    expect(combined).not.toMatch(/safe-integer decimal/);
    expect(combined).toMatch(
      /Could not resolve release tag|Static asset manifest|manifest is missing|ENOENT|no such file/i,
    );
  });
});
