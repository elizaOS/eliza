/**
 * Unit tests for hook eligibility checking and configuration resolution.
 */

import { platform } from "node:os";
import { describe, expect, it } from "vitest";
import type { InternalHooksConfig } from "../config/types.hooks.js";
import { checkEligibility, resolveHookConfig } from "./eligibility.js";
import type { ElizaHookMetadata } from "./types.js";

describe("hook-eligibility", () => {
  it("returns eligible when no metadata is provided", () => {
    const result = checkEligibility(undefined, undefined);
    expect(result.eligible).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("checks OS requirements", () => {
    const currentOs = platform();
    const matchingMetadata: ElizaHookMetadata = {
      name: "os-hook",
      description: "OS Hook",
      os: [currentOs],
    };

    expect(checkEligibility(matchingMetadata, undefined).eligible).toBe(true);

    const nonMatchingMetadata: ElizaHookMetadata = {
      name: "other-os-hook",
      description: "Other OS Hook",
      os: ["nonexistent_os" as NodeJS.Platform],
    };

    const res = checkEligibility(nonMatchingMetadata, undefined);
    expect(res.eligible).toBe(false);
    expect(res.missing[0]).toContain("OS: requires");
  });

  it("evaluates required environment variables and hookConfig fallbacks", () => {
    const metadata: ElizaHookMetadata = {
      name: "env-hook",
      description: "Env Hook",
      requires: {
        env: ["TEST_HOOK_SECRET_KEY_123"],
      },
    };

    const missingRes = checkEligibility(metadata, undefined);
    expect(missingRes.eligible).toBe(false);
    expect(missingRes.missing).toEqual([
      "Env missing: TEST_HOOK_SECRET_KEY_123",
    ]);

    const withHookConfig = checkEligibility(metadata, {
      env: { TEST_HOOK_SECRET_KEY_123: "valid_secret" },
    });
    expect(withHookConfig.eligible).toBe(true);
  });

  it("evaluates nested config path requirements", () => {
    const metadata: ElizaHookMetadata = {
      name: "config-hook",
      description: "Config Hook",
      requires: {
        config: ["features.voice.enabled"],
      },
    };

    expect(
      checkEligibility(metadata, undefined, {
        features: { voice: { enabled: false } },
      }).eligible,
    ).toBe(false);

    expect(
      checkEligibility(metadata, undefined, {
        features: { voice: { enabled: true } },
      }).eligible,
    ).toBe(true);
  });

  it("resolves hook configuration from InternalHooksConfig", () => {
    const internalConfig: InternalHooksConfig = {
      entries: {
        "pre-action": { enabled: true, priority: 10 },
      },
    };

    expect(resolveHookConfig(internalConfig, "pre-action")).toEqual({
      enabled: true,
      priority: 10,
    });
    expect(resolveHookConfig(internalConfig, "post-action")).toBeUndefined();
    expect(resolveHookConfig(undefined, "pre-action")).toBeUndefined();
  });
});
