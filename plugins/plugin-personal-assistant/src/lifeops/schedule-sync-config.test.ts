/** Ensures LifeOps schedule sync consumes the launcher-authoritative operational Cloud view. */
import {
  captureDevCloudEnvAuthoritySnapshot,
  resetDevCloudEnvAuthorityForTests,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configMocks = vi.hoisted(() => ({
  durable: {} as Record<string, unknown>,
  effective: {} as Record<string, unknown>,
}));

vi.mock("@elizaos/agent", () => ({
  loadElizaConfig: () => configMocks.durable,
  loadEffectiveElizaConfig: () => configMocks.effective,
}));

import { resolveLifeOpsScheduleSyncConfigFromElizaConfig } from "./schedule-sync-config";

const originalCloudEnv = {
  apiKey: process.env.ELIZAOS_CLOUD_API_KEY,
  agentId: process.env.ELIZAOS_CLOUD_AGENT_ID,
  baseUrl: process.env.ELIZAOS_CLOUD_BASE_URL,
  remoteToken: process.env.ELIZA_REMOTE_ACCESS_TOKEN,
  devSource: process.env.ELIZA_DEV_SOURCE,
  devAuthority: process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY,
  devTarget: process.env.ELIZA_DEV_CLOUD_TARGET,
};

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  delete process.env.ELIZA_DEV_SOURCE;
  delete process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
  delete process.env.ELIZA_DEV_CLOUD_TARGET;
  configMocks.durable = {};
  configMocks.effective = {};
  delete process.env.ELIZAOS_CLOUD_API_KEY;
  delete process.env.ELIZAOS_CLOUD_AGENT_ID;
  delete process.env.ELIZAOS_CLOUD_BASE_URL;
  delete process.env.ELIZA_REMOTE_ACCESS_TOKEN;
});

afterEach(() => {
  for (const [key, value] of [
    ["ELIZAOS_CLOUD_API_KEY", originalCloudEnv.apiKey],
    ["ELIZAOS_CLOUD_AGENT_ID", originalCloudEnv.agentId],
    ["ELIZAOS_CLOUD_BASE_URL", originalCloudEnv.baseUrl],
    ["ELIZA_REMOTE_ACCESS_TOKEN", originalCloudEnv.remoteToken],
    ["ELIZA_DEV_SOURCE", originalCloudEnv.devSource],
    ["ELIZA_DEV_CLOUD_ENV_AUTHORITY", originalCloudEnv.devAuthority],
    ["ELIZA_DEV_CLOUD_TARGET", originalCloudEnv.devTarget],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetDevCloudEnvAuthorityForTests();
});

describe("LifeOps schedule-sync Cloud authority", () => {
  it("uses the effective staging view instead of durable production topology", () => {
    configMocks.durable = {
      cloud: {
        remoteApiBase: "https://api.eliza.app/api/v1",
        remoteAccessToken: "persisted-production-access-token",
        apiKey: "persisted-production-key",
        baseUrl: "https://api.eliza.app/api/v1",
        agentId: "production-agent",
      },
    };
    configMocks.effective = {
      cloud: {
        apiKey: "staging-key",
        baseUrl: "https://api-staging.eliza.app/api/v1",
        agentId: "staging-agent",
      },
    };

    expect(resolveLifeOpsScheduleSyncConfigFromElizaConfig()).toEqual({
      configured: true,
      mode: "cloud",
      apiBaseUrl: "https://api-staging.eliza.app/api/v1",
      apiKey: "staging-key",
      agentId: "staging-agent",
    });
  });

  it("does not revive durable remote sync in staging-default mode", () => {
    configMocks.durable = {
      cloud: {
        remoteApiBase: "https://api.eliza.app/api/v1",
        remoteAccessToken: "persisted-production-access-token",
      },
    };
    configMocks.effective = {
      cloud: {
        enabled: false,
        baseUrl: "https://api-staging.eliza.app/api/v1",
        apiKey: "",
      },
    };

    expect(resolveLifeOpsScheduleSyncConfigFromElizaConfig()).toEqual({
      configured: false,
      mode: "none",
    });
  });

  it("does not revive schedule sync from late process.env pollution", () => {
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";
    process.env.ELIZA_DEV_CLOUD_TARGET = "staging";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api-staging.eliza.app/api/v1";
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.ELIZAOS_CLOUD_AGENT_ID;
    resetDevCloudEnvAuthorityForTests();
    captureDevCloudEnvAuthoritySnapshot();

    process.env.ELIZAOS_CLOUD_API_KEY = "late-production-key";
    process.env.ELIZAOS_CLOUD_AGENT_ID = "late-production-agent";
    process.env.ELIZAOS_CLOUD_BASE_URL = "https://api.eliza.app/api/v1";
    configMocks.effective = {
      cloud: {
        enabled: false,
        apiKey: "",
        baseUrl: "https://api-staging.eliza.app/api/v1",
      },
    };

    expect(resolveLifeOpsScheduleSyncConfigFromElizaConfig()).toEqual({
      configured: false,
      mode: "none",
    });
  });
});
