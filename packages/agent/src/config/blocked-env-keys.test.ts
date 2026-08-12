/**
 * Verifies BLOCKED_ENV_KEYS is the single secret-key denylist shared by API env
 * writes and startup env collection: it must be the same Set instance the
 * plugin-discovery helpers use, cover the canonical secret keys, and make
 * collectConfigEnvVars drop those keys while passing safe ones through.
 *
 * Also verifies BLOCKED_ENV_KEYS is a superset of the core spawn-env policy so
 * the config-write boundary and the spawn sanitizer cannot drift.
 * Deterministic, no live services.
 */

import { BLOCKED_SPAWN_ENV_KEYS } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { BLOCKED_ENV_KEYS, isBlockedEnvKey } from "./blocked-env-keys";
import { collectConfigEnvVars } from "./env-vars";

describe("BLOCKED_ENV_KEYS", () => {
  it("is the canonical union used by API writes and startup env sync", async () => {
    const pluginDiscovery = await import("../api/plugin-discovery-helpers");

    expect(pluginDiscovery.BLOCKED_ENV_KEYS).toBe(BLOCKED_ENV_KEYS);
    expect(BLOCKED_ENV_KEYS.has("STEWARD_API_KEY")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("STEWARD_AGENT_TOKEN")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("ELIZA_CLOUD_CLIENT_ADDRESS_KEY")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("OPINION_API_KEY")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("OPINION_PRIVATE_KEY")).toBe(true);
  });

  it("is a superset of BLOCKED_SPAWN_ENV_KEYS so the two denylists cannot drift", () => {
    for (const key of BLOCKED_SPAWN_ENV_KEYS) {
      expect(BLOCKED_ENV_KEYS.has(key)).toBe(true);
    }
    // Spot-check keys from the original PR and the review follow-up
    expect(BLOCKED_ENV_KEYS.has("JAVA_TOOL_OPTIONS")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("JDK_JAVA_OPTIONS")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("GIT_SSH_COMMAND")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("GIT_SSH")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("GIT_ASKPASS")).toBe(true);
    expect(BLOCKED_ENV_KEYS.has("GIT_CONFIG_COUNT")).toBe(true);
  });

  it("isBlockedEnvKey catches indexed prefix families that exact-match misses", () => {
    // These are prefix-matched and would be missed by BLOCKED_ENV_KEYS.has()
    expect(isBlockedEnvKey("GIT_CONFIG_KEY_0")).toBe(true);
    expect(isBlockedEnvKey("GIT_CONFIG_VALUE_99")).toBe(true);
    expect(isBlockedEnvKey("NPM_CONFIG_REGISTRY")).toBe(true);
    expect(isBlockedEnvKey("UV_INDEX_URL")).toBe(true);
    // Exact-match keys still work
    expect(isBlockedEnvKey("LD_PRELOAD")).toBe(true);
    expect(isBlockedEnvKey("JAVA_TOOL_OPTIONS")).toBe(true);
    // Benign keys pass through
    expect(isBlockedEnvKey("GIT_AUTHOR_NAME")).toBe(false);
    expect(isBlockedEnvKey("NODE_ENV")).toBe(false);
  });

  it("blocks canonical secret keys during startup env collection", () => {
    const envVars = collectConfigEnvVars({
      env: {
        vars: {
          OPINION_API_KEY: "opinion-api",
          STEWARD_API_KEY: "steward-api",
          SAFE_PUBLIC_FLAG: "enabled",
        },
        OPINION_PRIVATE_KEY: "opinion-private",
        STEWARD_AGENT_TOKEN: "steward-token",
        SAFE_DIRECT_VALUE: "direct",
      },
    });

    expect(envVars).toEqual({
      SAFE_PUBLIC_FLAG: "enabled",
      SAFE_DIRECT_VALUE: "direct",
    });
  });

  it("blocks new injection primitives during config env collection", () => {
    const envVars = collectConfigEnvVars({
      env: {
        vars: {
          JDK_JAVA_OPTIONS: "-javaagent:/tmp/evil.jar",
          GIT_SSH: "/tmp/evil-ssh",
          GIT_CONFIG_KEY_0: "core.sshCommand",
          GIT_CONFIG_VALUE_0: "/tmp/evil-cmd",
          SAFE_FLAG: "true",
        },
      },
    });

    expect(envVars).toEqual({ SAFE_FLAG: "true" });
  });
});
