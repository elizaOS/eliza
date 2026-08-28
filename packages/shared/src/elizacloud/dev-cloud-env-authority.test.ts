import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyDevCloudAuthoritySnapshotToEnv,
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
  resolveDevCloudAuthorityEnvValue,
  resolveDevCloudEnvAuthority,
  resolveDevCloudStewardOperationalTuple,
} from "./dev-cloud-env-authority.ts";

const KEYS = [
  "ELIZA_DEV_SOURCE",
  "ELIZA_DEV_CLOUD_ENV_AUTHORITY",
  "ELIZA_DEV_CLOUD_TARGET",
  "ELIZA_API_TOKEN",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_BASE_URL",
  "ELIZAOS_CLOUD_SERVICE_KEY",
  "STEWARD_API_URL",
  "STEWARD_TENANT_ID",
  "STEWARD_AGENT_ID",
  "ELIZA_STEWARD_AGENT_ID",
  "STEWARD_API_KEY",
  "STEWARD_AGENT_TOKEN",
  "STEWARD_TRADE_SESSION_ID",
  "STEWARD_HYPERLIQUID_TRADE_SESSION_ID",
  "STEWARD_POLYMARKET_TRADE_SESSION_ID",
] as const;
let saved: Record<(typeof KEYS)[number], string | undefined>;

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  saved = Object.fromEntries(
    KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof KEYS)[number], string | undefined>;
  for (const key of KEYS) delete process.env[key];
});

afterEach(() => {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("development Cloud environment authority", () => {
  it("ignores an unowned marker", () => {
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";

    expect(resolveDevCloudEnvAuthority()).toBeNull();
  });

  it.each(["staging-default", "offline"] as const)(
    "freezes %s as connection-disabled and staging-pinned",
    (authority) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.ELIZA_DEV_CLOUD_TARGET =
        authority === "offline" ? "offline" : "staging";
      process.env.ELIZAOS_CLOUD_API_KEY = "inherited-production-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
      process.env.ELIZAOS_CLOUD_SERVICE_KEY =
        "inherited-production-service-key";

      const snapshot = captureDevCloudEnvAuthoritySnapshot();
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "production";
      process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
      process.env.ELIZAOS_CLOUD_BASE_URL = "https://attacker.example/api/v1";

      expect(snapshot?.authority).toBe(authority);
      expect(resolveDevCloudEnvAuthority()).toBe(authority);
      expect(resolveDevCloudAuthorityEnvValue("ELIZA_DEV_CLOUD_TARGET")).toBe(
        authority === "offline" ? "offline" : "staging",
      );
      expect(resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_API_KEY")).toBe(
        "",
      );
      expect(
        resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_SERVICE_KEY"),
      ).toBe("");
      expect(resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_BASE_URL")).toBe(
        "https://api-staging.eliza.app/api/v1",
      );
    },
  );

  it("keeps the original explicit staging credential after live env mutation", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZAOS_CLOUD_API_KEY = "staging-launch-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";

    expect(resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_API_KEY")).toBe(
      "staging-launch-key",
    );
    expect(resolveDevCloudAuthorityEnvValue("ELIZAOS_CLOUD_BASE_URL")).toBe(
      "https://api-staging.eliza.app/api/v1",
    );
  });

  it("projects only the frozen authority tuple into a restarted child", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.ELIZA_DEV_CLOUD_TARGET = "staging";
    process.env.ELIZAOS_CLOUD_API_KEY = "staging-launch-key";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    process.env.ELIZA_API_TOKEN = "desktop-loopback-token";
    process.env.STEWARD_API_URL = "https://staging.eliza.app/steward";
    process.env.STEWARD_TENANT_ID = "elizacloud-staging";
    process.env.STEWARD_AGENT_ID = "staging-agent";
    process.env.STEWARD_AGENT_TOKEN = "staging-agent-token";
    const snapshot = captureDevCloudEnvAuthoritySnapshot();

    const childEnv: Record<string, string | undefined> = {
      PATH: "/usr/bin",
      ELIZA_DEV_SOURCE: "1",
      ELIZA_DEV_CLOUD_ENV_AUTHORITY: "production",
      ELIZA_DEV_CLOUD_TARGET: "production",
      ELIZAOS_CLOUD_API_KEY: "late-production-key",
      ELIZAOS_CLOUD_BASE_URL: "https://attacker.example/api/v1",
      ELIZAOS_CLOUD_LATE_OVERRIDE: "late-attacker-key",
      ELIZA_API_TOKEN: "late-loopback-token",
      STEWARD_API_URL: "https://attacker.example/steward",
      STEWARD_AGENT_TOKEN: "late-attacker-token",
    };

    expect(applyDevCloudAuthoritySnapshotToEnv(childEnv, snapshot)).toBe(true);
    expect(childEnv).toMatchObject({
      PATH: "/usr/bin",
      ELIZA_DEV_SOURCE: "1",
      ELIZA_DEV_CLOUD_ENV_AUTHORITY: "staging-explicit",
      ELIZA_DEV_CLOUD_TARGET: "staging",
      ELIZAOS_CLOUD_API_KEY: "staging-launch-key",
      ELIZAOS_CLOUD_BASE_URL: "https://api-staging.eliza.app/api/v1",
      ELIZA_API_TOKEN: "desktop-loopback-token",
      STEWARD_API_URL: "https://staging.eliza.app/steward",
      STEWARD_AGENT_TOKEN: "staging-agent-token",
    });
    expect(childEnv.ELIZAOS_CLOUD_LATE_OVERRIDE).toBeUndefined();
  });

  it("leaves an unowned child environment unchanged", () => {
    const childEnv = { PATH: "/usr/bin", ELIZAOS_CLOUD_API_KEY: "direct-key" };

    expect(applyDevCloudAuthoritySnapshotToEnv(childEnv, null)).toBe(false);
    expect(childEnv).toEqual({
      PATH: "/usr/bin",
      ELIZAOS_CLOUD_API_KEY: "direct-key",
    });
  });

  it.each(["staging-default", "offline"] as const)(
    "keeps operational Steward disabled under %s after late credential pollution",
    (authority) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = authority;
      process.env.STEWARD_API_URL = "https://eliza.app/steward";
      process.env.STEWARD_TENANT_ID = "elizacloud";
      process.env.STEWARD_AGENT_ID = "production-agent";
      process.env.STEWARD_API_KEY = "production-key";
      process.env.STEWARD_AGENT_TOKEN = "production-token";

      captureDevCloudEnvAuthoritySnapshot();

      process.env.STEWARD_API_URL = "https://attacker.example/steward";
      process.env.STEWARD_TENANT_ID = "attacker";
      process.env.STEWARD_AGENT_ID = "attacker-agent";
      process.env.STEWARD_API_KEY = "attacker-key";
      process.env.STEWARD_AGENT_TOKEN = "attacker-token";

      expect(resolveDevCloudStewardOperationalTuple()).toEqual({
        authority,
        enabled: false,
      });
      expect(resolveDevCloudAuthorityEnvValue("STEWARD_API_URL")).toBe("");
      expect(resolveDevCloudAuthorityEnvValue("STEWARD_AGENT_TOKEN")).toBe("");
    },
  );

  it("uses one complete explicit Steward tuple after late URL, identity, and credential mutation", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.STEWARD_API_URL = "https://staging.eliza.app/steward";
    process.env.STEWARD_TENANT_ID = "elizacloud-staging";
    process.env.STEWARD_AGENT_ID = "staging-agent";
    process.env.STEWARD_API_KEY = "staging-key";
    process.env.STEWARD_AGENT_TOKEN = "staging-token";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.STEWARD_API_URL = "https://eliza.app/steward";
    process.env.STEWARD_TENANT_ID = "elizacloud";
    process.env.STEWARD_AGENT_ID = "production-agent";
    process.env.STEWARD_API_KEY = "production-key";
    process.env.STEWARD_AGENT_TOKEN = "production-token";

    expect(resolveDevCloudStewardOperationalTuple()).toEqual({
      authority: "staging-explicit",
      enabled: true,
      apiUrl: "https://staging.eliza.app/steward",
      tenantId: "elizacloud-staging",
      agentId: "staging-agent",
      apiKey: "staging-key",
      agentToken: "staging-token",
    });
  });

  it("does not let late runtime values complete an insufficient explicit Steward launch tuple", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-explicit";
    process.env.STEWARD_API_URL = "https://staging.eliza.app/steward";
    process.env.STEWARD_TENANT_ID = "elizacloud-staging";
    process.env.STEWARD_AGENT_ID = "staging-agent";
    captureDevCloudEnvAuthoritySnapshot();

    process.env.STEWARD_API_URL = "https://eliza.app/steward";
    process.env.STEWARD_API_KEY = "late-production-key";
    process.env.STEWARD_AGENT_TOKEN = "late-production-token";

    expect(resolveDevCloudStewardOperationalTuple()).toEqual({
      authority: "staging-explicit",
      enabled: false,
    });
    expect(resolveDevCloudAuthorityEnvValue("STEWARD_API_URL")).toBe("");
    expect(resolveDevCloudAuthorityEnvValue("STEWARD_AGENT_ID")).toBe("");
  });

  it.each(["[REDACTED]", "vault://steward/agent-token"])(
    "rejects an explicit Steward placeholder credential: %s",
    (placeholder) => {
      process.env.ELIZA_DEV_SOURCE = "1";
      process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "self-hosted";
      process.env.STEWARD_API_URL = "https://steward.private.example";
      process.env.STEWARD_AGENT_ID = "private-agent";
      process.env.STEWARD_AGENT_TOKEN = placeholder;

      expect(resolveDevCloudStewardOperationalTuple()).toEqual({
        authority: "self-hosted",
        enabled: false,
      });
      expect(resolveDevCloudAuthorityEnvValue("STEWARD_AGENT_TOKEN")).toBe("");
    },
  );
});
