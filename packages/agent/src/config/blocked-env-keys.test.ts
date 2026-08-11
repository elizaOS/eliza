/**
 * Verifies BLOCKED_ENV_KEYS is the single secret-key denylist shared by API env
 * writes and startup env collection: it must be the same Set instance the
 * plugin-discovery helpers use, cover the canonical secret keys, and make
 * collectConfigEnvVars drop those keys while passing safe ones through.
 * Deterministic, no live services.
 */
import { describe, expect, it } from "vitest";
import { BLOCKED_ENV_KEYS } from "./blocked-env-keys";
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

  it("is a superset of core's spawn denylist so the two cannot drift", async () => {
    // BLOCKED_SPAWN_ENV_KEYS guards a caller-supplied child environment. This
    // list guards config/API writes, which reach process.env and are then
    // inherited by every spawn site that passes no explicit env. A key blocked
    // there but not here is reachable through that path.
    const { BLOCKED_SPAWN_ENV_KEYS } = await import(
      "@elizaos/core/security/spawn-env-policy"
    );
    const missing = [...BLOCKED_SPAWN_ENV_KEYS].filter(
      (key) => !BLOCKED_ENV_KEYS.has(key),
    );
    expect(missing).toEqual([]);
  });

  it("blocks the loader and interpreter hijack keys reachable through process.env", () => {
    for (const key of [
      "LD_AUDIT",
      "DYLD_FRAMEWORK_PATH",
      "PYTHONPATH",
      "PYTHONSTARTUP",
      "PYTHONHOME",
      "PERL5OPT",
      "PERL5LIB",
      "RUBYOPT",
      "RUBYLIB",
    ]) {
      expect(BLOCKED_ENV_KEYS.has(key)).toBe(true);
    }
  });

  it("drops loader hijack keys during startup env collection", () => {
    const envVars = collectConfigEnvVars({
      env: {
        vars: {
          LD_AUDIT: "/tmp/evil.so",
          PYTHONPATH: "/tmp/evil-modules",
          SAFE_PUBLIC_FLAG: "enabled",
        },
        DYLD_FRAMEWORK_PATH: "/tmp/evil-frameworks",
        RUBYOPT: "-r/tmp/evil",
        SAFE_DIRECT_VALUE: "direct",
      },
    });

    expect(envVars).toEqual({
      SAFE_PUBLIC_FLAG: "enabled",
      SAFE_DIRECT_VALUE: "direct",
    });
  });

  it("still allows ordinary application keys that only look loader-adjacent", () => {
    expect(BLOCKED_ENV_KEYS.has("PYTHON_VERSION")).toBe(false);
    expect(BLOCKED_ENV_KEYS.has("NODE_ENV")).toBe(false);
    expect(BLOCKED_ENV_KEYS.has("LD_FLAGS")).toBe(false);
    expect(BLOCKED_ENV_KEYS.has("RUBY_VERSION")).toBe(false);
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
});
