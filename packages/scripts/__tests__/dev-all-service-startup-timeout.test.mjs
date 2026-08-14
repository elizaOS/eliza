/**
 * Focused coverage for `DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS` validation in
 * dev-all: parser contract plus real CLI boundary rejections before prepare.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_SERVICE_STARTUP_TIMEOUT_MS,
  parsePositiveSafeInteger,
  resolveServiceStartupTimeoutMs,
} from "../dev-all.mjs";
import { spawnSync } from "../lib/spawn-sync-captured.mjs";

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dev-all.mjs",
);

function runCli(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS: undefined,
      ...env,
    },
    timeout: 10_000,
  });
}

describe("parsePositiveSafeInteger", () => {
  test("accepts positive safe integers as strings and numbers", () => {
    expect(parsePositiveSafeInteger("1", "label")).toBe(1);
    expect(parsePositiveSafeInteger("120000", "label")).toBe(120000);
    expect(parsePositiveSafeInteger(90, "label")).toBe(90);
    expect(parsePositiveSafeInteger(" 5000 ", "label")).toBe(5000);
  });

  test("rejects zero, negative, partial, signed, fractional, and non-decimal forms", () => {
    const bad = [
      "0",
      "-1",
      "1.5",
      "1junk",
      "+120000",
      "0x10",
      "1e2",
      "0120000",
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

describe("resolveServiceStartupTimeoutMs", () => {
  test("uses default when unset or empty", () => {
    expect(resolveServiceStartupTimeoutMs({})).toBe(
      DEFAULT_SERVICE_STARTUP_TIMEOUT_MS,
    );
    expect(
      resolveServiceStartupTimeoutMs({
        DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS: "",
      }),
    ).toBe(DEFAULT_SERVICE_STARTUP_TIMEOUT_MS);
    expect(
      resolveServiceStartupTimeoutMs({
        DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS: "   ",
      }),
    ).toBe(DEFAULT_SERVICE_STARTUP_TIMEOUT_MS);
  });

  test("accepts a valid explicit timeout", () => {
    expect(
      resolveServiceStartupTimeoutMs({
        DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS: "45000",
      }),
    ).toBe(45000);
  });

  test("fails closed on explicit invalid env values", () => {
    for (const value of [
      "0",
      "1junk",
      "notanumber",
      "1.5",
      "+120000",
      "-5",
      "0120000",
    ]) {
      expect(() =>
        resolveServiceStartupTimeoutMs({
          DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS: value,
        }),
      ).toThrow(
        /DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS must be a positive safe-integer decimal/,
      );
    }
  });
});

describe("dev-all CLI boundary", () => {
  test("rejects invalid DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS before plan output", () => {
    for (const value of ["0", "1junk", "notanumber", "1.5", "+120000"]) {
      const result = runCli(["--dry-run", "--no-prepare"], {
        DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS: value,
      });
      expect(result.status).not.toBe(0);
      const combined = `${result.stdout}${result.stderr}`;
      expect(combined).toMatch(
        /DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS must be a positive safe-integer decimal/,
      );
      expect(combined).not.toContain("[dev:all] local stack");
      expect(combined).not.toContain("using fast source prepare");
    }
  });

  test("accepts default timeout with dry-run and no-prepare", () => {
    const result = runCli(["--dry-run", "--no-prepare"], {});
    expect(result.status).toBe(0);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).toContain("[dev:all] local stack");
    expect(combined).toContain("skipping prepare steps");
  });

  test("accepts a valid explicit timeout with dry-run and no-prepare", () => {
    const result = runCli(["--dry-run", "--no-prepare"], {
      DEV_ALL_SERVICE_STARTUP_TIMEOUT_MS: "90000",
    });
    expect(result.status).toBe(0);
    const combined = `${result.stdout}${result.stderr}`;
    expect(combined).toContain("[dev:all] local stack");
  });

  test("rejects malformed port configuration through a bounded usage error", () => {
    for (const [key, value] of [
      ["DEV_ALL_AGENT_API_PORT", "1e4"],
      ["DEV_ALL_FRONTEND_PORT", "abc"],
      ["DEV_ALL_CLOUD_API_PORT", "080"],
      ["DEV_ALL_CLOUD_DB_PORT", "0"],
    ]) {
      const result = runCli(["--dry-run", "--no-prepare"], { [key]: value });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`[dev:all] ${key} must be`);
      expect(result.stderr).not.toContain("at parseCanonicalInt");
      expect(result.stderr).not.toContain("Bun v");
    }
  });
});
