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
