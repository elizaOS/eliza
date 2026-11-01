import { describe, expect, it } from "vitest";
import {
  forwardableSubAgentEnv,
  isDeniedSubAgentEnvKey,
  isForwardedCloudCredentialKey,
} from "../services/sub-agent-env-policy.ts";

// Host-side ELIZA_* secrets a coding sub-agent never needs. The values are
// placeholders; the test is about which names survive the filter.
const HOST_ONLY = {
  ELIZA_WALLET_EXPORT_TOKEN: "wallet-step-up",
  ELIZA_DEVICE_PAIRING_TOKEN: "pairing",
  ELIZA_DEVICE_BRIDGE_TOKEN: "bridge",
  ELIZA_TOKEN_ENCRYPTION_KEY: "at-rest-key",
  ELIZA_SERVICE_JWT_SECRET: "jwt",
  ELIZA_WEB_PUSH_VAPID_PRIVATE_KEY: "vapid",
};
const CLOUD_ALIASES = {
  ELIZA_CLOUD_API_KEY: "owner-cloud-bearer",
  ELIZA_CLOUD_TOKEN: "owner-cloud-token",
};
const FORWARDED = {
  PATH: "/usr/bin",
  ELIZA_CLAUDE_EFFORT: "high",
  ELIZA_CLOUD_BASE_URL: "https://cloud.example",
  ELIZA_APP_IMAGE_REGISTRY_USERNAME: "pusher",
  ELIZA_APP_IMAGE_REGISTRY_TOKEN: "registry-push",
};

describe("sub-agent env: host-only ELIZA_* credentials", () => {
  it("forwards a sub-agent's own ELIZA_* settings but not host step-up secrets", () => {
    const env = forwardableSubAgentEnv({
      ...HOST_ONLY,
      ...CLOUD_ALIASES,
      ...FORWARDED,
    });
    expect(Object.keys(env).sort()).toEqual(Object.keys(FORWARDED).sort());
  });

  it("lets the ELIZA_CLOUD_* credential aliases follow the ELIZAOS_CLOUD opt-in", () => {
    const env = forwardableSubAgentEnv(
      { ...HOST_ONLY, ...CLOUD_ALIASES, ...FORWARDED },
      true,
    );
    expect(Object.keys(env).sort()).toEqual(
      [...Object.keys(FORWARDED), ...Object.keys(CLOUD_ALIASES)].sort(),
    );
    for (const key of Object.keys(CLOUD_ALIASES)) {
      expect(isForwardedCloudCredentialKey(key)).toBe(true);
    }
    expect(isForwardedCloudCredentialKey("ELIZA_CLOUD_BASE_URL")).toBe(false);
  });

  it("denies the same secrets when a spawn request supplies them as customCredentials", () => {
    for (const key of Object.keys(HOST_ONLY)) {
      expect(isDeniedSubAgentEnvKey(key)).toBe(true);
    }
    expect(isDeniedSubAgentEnvKey("eliza_wallet_export_token")).toBe(true);
    expect(isDeniedSubAgentEnvKey("ELIZA_APP_IMAGE_REGISTRY_TOKEN")).toBe(
      false,
    );
    expect(isDeniedSubAgentEnvKey("ELIZA_CLAUDE_EFFORT")).toBe(false);
  });
});
