/**
 * Unit tests for sub-agent environment policy: validates deny list regex matching
 * and system essential keys.
 */
import {
  resetDevCloudEnvAuthorityForTests,
  resolveDevCloudEnvAuthority,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDevCloudAuthorityToSubAgentEnv,
  forwardableSubAgentEnv,
  isDeniedSubAgentEnvKey,
  SUB_AGENT_SYSTEM_ENV_KEYS,
} from "./sub-agent-env-policy.ts";

const AUTHORITY_ENV_KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_DEV_CLOUD_TARGET",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_SERVICE_KEY",
  "ELIZA_CLOUD_API_KEY",
  "ELIZA_CLOUD_TOKEN",
  "ELIZA_CLOUD_BASE_URL",
  "ELIZACLOUD_API_KEY",
  "WAIFU_ELIZA_CLOUD_AGENT_ID",
] as const;
const savedAuthorityEnv = Object.fromEntries(
  AUTHORITY_ENV_KEYS.map((key) => [key, process.env[key]]),
);

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  for (const key of AUTHORITY_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of AUTHORITY_ENV_KEYS) {
    const value = savedAuthorityEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("sub-agent-env-policy", () => {
  it("denies sensitive tokens and credentials", () => {
    expect(isDeniedSubAgentEnvKey("DISCORD_API_TOKEN")).toBe(true);
    expect(isDeniedSubAgentEnvKey("TELEGRAM_BOT_TOKEN")).toBe(true);
    expect(isDeniedSubAgentEnvKey("SLACK_BOT_TOKEN")).toBe(true);
    expect(isDeniedSubAgentEnvKey("ELIZA_VAULT_PASSPHRASE")).toBe(true);
    expect(isDeniedSubAgentEnvKey("GITHUB_TOKEN")).toBe(true);
    expect(isDeniedSubAgentEnvKey("TERMINAL_RUN_TOKEN")).toBe(true);
  });

  it("allows harmless operational environment variables", () => {
    expect(isDeniedSubAgentEnvKey("NODE_ENV")).toBe(false);
    expect(isDeniedSubAgentEnvKey("PORT")).toBe(false);
    expect(isDeniedSubAgentEnvKey("PATH")).toBe(false);
  });

  it("includes core OS keys in system list", () => {
    expect(SUB_AGENT_SYSTEM_ENV_KEYS).toContain("PATH");
    expect(SUB_AGENT_SYSTEM_ENV_KEYS).toContain("HOME");
    expect(SUB_AGENT_SYSTEM_ENV_KEYS).toContain("USER");
  });

  it.each(["staging-default", "offline"] as const)(
    "drops every Cloud credential under blocked %s authority even with opt-in and overlays",
    (authority) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_BASE_URL =
        "https://api-staging.eliza.app/api/v1";
      process.env.ELIZAOS_CLOUD_API_KEY = "";
      expect(resolveDevCloudEnvAuthority()).toBe(authority);
      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";

      const forwarded = forwardableSubAgentEnv(
        {
          PATH: "/usr/bin",
          ELIZA_DEV_SOURCE: "1",
          ELIZA_DEV_CLOUD_ENV_AUTHORITY: authority,
          ELIZAOS_CLOUD_API_KEY: "late-production-key",
          ELIZAOS_CLOUD_SERVICE_KEY: "late-service-key",
          ELIZA_CLOUD_TOKEN: "legacy-production-token",
          ELIZACLOUD_API_KEY: "legacy-production-key",
        },
        true,
      );
      applyDevCloudAuthorityToSubAgentEnv(
        Object.assign(forwarded, {
          ELIZAOS_CLOUD_API_KEY: "custom-overlay-key",
          ELIZA_CLOUD_API_KEY: "custom-legacy-key",
          ELIZA_CLOUD_BASE_URL: "https://api.eliza.app",
        }),
      );

      expect(forwarded).toEqual({
        PATH: "/usr/bin",
        ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      });
    },
  );

  it.each([
    [
      "staging-explicit",
      "https://api-staging.eliza.app/api/v1",
      "staging-launch-key",
    ],
    [
      "self-hosted",
      "https://cloud.internal.example/api/v1",
      "selfhost-launch-key",
    ],
  ] as const)(
    "projects only the frozen canonical tuple under %s authority",
    (authority, launchBaseUrl, launchApiKey) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZAOS_CLOUD_BASE_URL = launchBaseUrl;
      process.env.ELIZAOS_CLOUD_API_KEY = launchApiKey;
      expect(resolveDevCloudEnvAuthority()).toBe(authority);
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";

      const forwarded = forwardableSubAgentEnv(
        {
          PATH: "/usr/bin",
          ELIZA_DEV_SOURCE: "1",
          ELIZA_DEV_CLOUD_ENV_AUTHORITY: authority,
          ELIZAOS_CLOUD_API_KEY: "late-production-key",
          ELIZAOS_CLOUD_BASE_URL: "https://api.eliza.app/api/v1",
          ELIZAOS_CLOUD_SERVICE_KEY: "late-service-key",
          ELIZA_CLOUD_TOKEN: "legacy-production-token",
          ELIZA_CLOUD_BASE_URL: "https://api.eliza.app",
          WAIFU_ELIZA_CLOUD_AGENT_ID: "late-agent-id",
        },
        true,
      );
      applyDevCloudAuthorityToSubAgentEnv(
        Object.assign(forwarded, {
          ELIZAOS_CLOUD_API_KEY: "custom-overlay-key",
          ELIZAOS_CLOUD_BASE_URL: "https://custom.example/api/v1",
          ELIZA_CLOUD_TOKEN: "custom-legacy-token",
        }),
      );

      expect(forwarded).toEqual({
        PATH: "/usr/bin",
        ELIZAOS_CLOUD_API_KEY: launchApiKey,
        ELIZAOS_CLOUD_BASE_URL: launchBaseUrl,
      });
    },
  );
});
