/**
 * Unit coverage for hook eligibility against the real checkEligibility and
 * resolveHookConfig implementations — deterministic, no mocks: binary lookups
 * resolve through the live runner executable and environment state is saved
 * and restored around each case.
 */

import { platform } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { HookConfig, InternalHooksConfig } from "../config/types.hooks.ts";
import { checkEligibility, resolveHookConfig } from "./eligibility.ts";
import type { ElizaHookMetadata } from "./types.ts";

const MISSING_BIN = "eliza-test-definitely-not-a-real-binary";
const RUNNER_BIN_BASENAME = process.execPath.split("/").pop() as string;
const TEST_ENV_VAR = "ELIZA_TEST_ELIGIBILITY_ENV";

function metadata(
  overrides: Partial<ElizaHookMetadata> = {},
): ElizaHookMetadata {
  return { events: [], ...overrides };
}

let originalTestEnvVar: string | undefined;

beforeEach(() => {
  originalTestEnvVar = process.env[TEST_ENV_VAR];
  delete process.env[TEST_ENV_VAR];
});

afterEach(() => {
  if (originalTestEnvVar === undefined) {
    delete process.env[TEST_ENV_VAR];
  } else {
    process.env[TEST_ENV_VAR] = originalTestEnvVar;
  }
});

describe("checkEligibility", () => {
  test("undefined metadata is always eligible", () => {
    expect(checkEligibility(undefined, undefined)).toEqual({
      eligible: true,
      missing: [],
    });
  });

  test("metadata with no requirements is eligible", () => {
    expect(checkEligibility(metadata(), undefined)).toEqual({
      eligible: true,
      missing: [],
    });
  });

  test("an OS list not containing the current platform is ineligible", () => {
    const result = checkEligibility(metadata({ os: ["win32"] }), undefined);
    expect(result.eligible).toBe(false);
    expect(result.missing).toEqual([
      `OS: requires win32, current: ${platform()}`,
    ]);
  });

  test("an OS list containing the current platform imposes no missing entry", () => {
    const result = checkEligibility(metadata({ os: [platform()] }), undefined);
    expect(result).toEqual({ eligible: true, missing: [] });
  });

  test("always short-circuits after the OS check but before bins/env/config", () => {
    const requires = {
      bins: [MISSING_BIN],
      anyBins: [MISSING_BIN],
      env: [TEST_ENV_VAR],
      config: ["eliza.test.missing"],
    };
    const mismatched = checkEligibility(
      metadata({ always: true, os: ["win32"], requires }),
      undefined,
      { eliza: { test: { missing: false } } },
    );
    expect(mismatched.missing).toEqual([
      `OS: requires win32, current: ${platform()}`,
    ]);

    const matched = checkEligibility(
      metadata({ always: true, os: [platform()], requires }),
      undefined,
      {},
    );
    expect(matched).toEqual({ eligible: true, missing: [] });
  });

  test("a required binary resolved by absolute path exists", () => {
    const result = checkEligibility(
      metadata({ requires: { bins: [process.execPath] } }),
      undefined,
    );
    expect(result).toEqual({ eligible: true, missing: [] });
  });

  test("a required binary next to the running executable resolves without PATH", () => {
    const result = checkEligibility(
      metadata({ requires: { bins: [RUNNER_BIN_BASENAME] } }),
      undefined,
    );
    expect(result).toEqual({ eligible: true, missing: [] });
  });

  test("every absent required binary is reported individually", () => {
    const result = checkEligibility(
      metadata({
        requires: { bins: [MISSING_BIN, `${MISSING_BIN}-2`] },
      }),
      undefined,
    );
    expect(result).toEqual({
      eligible: false,
      missing: [
        `Binary missing: ${MISSING_BIN}`,
        `Binary missing: ${MISSING_BIN}-2`,
      ],
    });
  });

  test("anyBins passes when at least one candidate resolves", () => {
    const result = checkEligibility(
      metadata({
        requires: { anyBins: [MISSING_BIN, RUNNER_BIN_BASENAME] },
      }),
      undefined,
    );
    expect(result).toEqual({ eligible: true, missing: [] });
  });

  test("anyBins reports the full candidate list when none resolve", () => {
    const result = checkEligibility(
      metadata({
        requires: { anyBins: [MISSING_BIN, `${MISSING_BIN}-2`] },
      }),
      undefined,
    );
    expect(result).toEqual({
      eligible: false,
      missing: [`None of: ${MISSING_BIN}, ${MISSING_BIN}-2`],
    });
  });

  test("anyBins with an empty candidate list imposes no requirement", () => {
    const result = checkEligibility(
      metadata({ requires: { anyBins: [] } }),
      undefined,
    );
    expect(result).toEqual({ eligible: true, missing: [] });
  });

  test("a required env variable may be satisfied by the process environment", () => {
    process.env[TEST_ENV_VAR] = "1";
    const result = checkEligibility(
      metadata({ requires: { env: [TEST_ENV_VAR] } }),
      undefined,
    );
    expect(result).toEqual({ eligible: true, missing: [] });
  });

  test("a required env variable may be satisfied by the hook config", () => {
    const hookConfig: HookConfig = { env: { [TEST_ENV_VAR]: "1" } };
    const result = checkEligibility(
      metadata({ requires: { env: [TEST_ENV_VAR] } }),
      hookConfig,
    );
    expect(result).toEqual({ eligible: true, missing: [] });
  });

  test("a required env variable absent from both sources is reported", () => {
    const result = checkEligibility(
      metadata({ requires: { env: [TEST_ENV_VAR] } }),
      { env: {} },
    );
    expect(result).toEqual({
      eligible: false,
      missing: [`Env missing: ${TEST_ENV_VAR}`],
    });
  });

  test("required config paths are satisfied by truthy nested values", () => {
    const elizaConfig = { features: { hooks: { premium: "yes" } } };
    const result = checkEligibility(
      metadata({ requires: { config: ["features.hooks.premium"] } }),
      undefined,
      elizaConfig,
    );
    expect(result).toEqual({ eligible: true, missing: [] });
  });

  test.each([undefined, null, false, "", 0])(
    "config path resolving to %p is reported missing",
    (falsyValue) => {
      const elizaConfig = { features: { hooks: { flag: falsyValue } } };
      const result = checkEligibility(
        metadata({ requires: { config: ["features.hooks.flag"] } }),
        undefined,
        elizaConfig,
      );
      expect(result).toEqual({
        eligible: false,
        missing: ["Config missing: features.hooks.flag"],
      });
    },
  );

  test("a config path traversing through a primitive resolves to missing", () => {
    const result = checkEligibility(
      metadata({ requires: { config: ["features.hooks.flag"] } }),
      undefined,
      { features: "not-an-object" },
    );
    expect(result).toEqual({
      eligible: false,
      missing: ["Config missing: features.hooks.flag"],
    });
  });

  test("missing entries accumulate in os, bin, env, then config order", () => {
    const result = checkEligibility(
      metadata({
        os: ["win32"],
        requires: {
          bins: [MISSING_BIN],
          env: [TEST_ENV_VAR],
          config: ["features.hooks.flag"],
        },
      }),
      undefined,
      {},
    );
    expect(result.eligible).toBe(false);
    expect(result.missing).toEqual([
      `OS: requires win32, current: ${platform()}`,
      `Binary missing: ${MISSING_BIN}`,
      `Env missing: ${TEST_ENV_VAR}`,
      "Config missing: features.hooks.flag",
    ]);
  });

  test("fully satisfied requirements stay eligible in one call", () => {
    process.env[TEST_ENV_VAR] = "1";
    const result = checkEligibility(
      metadata({
        os: [platform()],
        requires: {
          bins: [process.execPath],
          anyBins: [MISSING_BIN, RUNNER_BIN_BASENAME],
          env: [TEST_ENV_VAR],
          config: ["features.enabled"],
        },
      }),
      undefined,
      { features: { enabled: true } },
    );
    expect(result).toEqual({ eligible: true, missing: [] });
  });
});

describe("resolveHookConfig", () => {
  test("returns the entry registered under the hook key", () => {
    const entry: HookConfig = { enabled: true };
    const internalConfig: InternalHooksConfig = {
      entries: { "my-hook": entry },
    };
    expect(resolveHookConfig(internalConfig, "my-hook")).toBe(entry);
  });

  test("returns undefined for an unregistered hook key", () => {
    const internalConfig: InternalHooksConfig = { entries: {} };
    expect(resolveHookConfig(internalConfig, "my-hook")).toBeUndefined();
  });

  test("returns undefined when no internal hooks config exists", () => {
    expect(resolveHookConfig(undefined, "my-hook")).toBeUndefined();
  });
});
