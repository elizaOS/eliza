/**
 * Wrapper-level regression coverage for the app-core Cloud compat dispatcher.
 * A launcher-owned development target must reach both billing and compat
 * handlers through the effective config view, never through durable production
 * topology or a key repaired from ambient/runtime state.
 */
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentCloudBillingRouteHandler } from "@elizaos/agent/api/cloud-route-contracts";
import { resetDevCloudEnvAuthorityForTests } from "@elizaos/agent/config/dev-cloud-env-authority";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const agentMocks = vi.hoisted(() => ({
  billing: vi.fn<AgentCloudBillingRouteHandler>(async () => true),
  compat: vi.fn<AgentCloudBillingRouteHandler>(async () => true),
  save: vi.fn(),
}));
const cloudSecretMocks = vi.hoisted(() => ({
  get: vi.fn<() => string | null>(() => null),
}));

vi.mock("@elizaos/agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/agent")>();
  return {
    ...actual,
    handleCloudBillingRoute: agentMocks.billing,
    handleCloudCompatRoute: agentMocks.compat,
    handleRuntimeModePreDispatch: vi.fn(async () => false),
    handleRuntimeModeRemoteForward: vi.fn(async () => false),
    saveElizaConfig: (
      config: Parameters<typeof actual.saveElizaConfig>[0],
    ): void => {
      agentMocks.save(config);
      actual.saveElizaConfig(config);
    },
  };
});

vi.mock("@elizaos/shared/elizacloud/cloud-secrets", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@elizaos/shared/elizacloud/cloud-secrets")
    >();
  return {
    ...actual,
    getCloudSecret: cloudSecretMocks.get,
  };
});

import type { CompatRuntimeState } from "./compat-route-shared";
import { handleElizaCompatRoute } from "./server";

const STAGING_API = "https://api-staging.eliza.app/api/v1";
const PRODUCTION_API = "https://api.eliza.app/api/v1";

let originalEnv: NodeJS.ProcessEnv;
let root = "";
let configPath = "";

function trustedLoopbackRequest(pathname: string): http.IncomingMessage {
  return {
    method: "GET",
    url: pathname,
    headers: { host: "127.0.0.1:2138" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as http.IncomingMessage;
}

function responseStub(): http.ServerResponse {
  return {
    statusCode: 200,
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  } as unknown as http.ServerResponse;
}

function routeState(runtimeSecret?: string): CompatRuntimeState {
  return {
    current: runtimeSecret
      ? ({
          character: {
            secrets: { ELIZAOS_CLOUD_API_KEY: runtimeSecret },
          },
        } as unknown as CompatRuntimeState["current"])
      : null,
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

function writeConfig(config: Record<string, unknown>): string {
  const serialized = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(configPath, serialized);
  return serialized;
}

function capturedConfig(mock: typeof agentMocks.billing, callIndex = 0) {
  return mock.mock.calls[callIndex]?.[4]?.config;
}

beforeEach(() => {
  resetDevCloudEnvAuthorityForTests();
  originalEnv = { ...process.env };
  root = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-cloud-authority-"));
  configPath = path.join(root, "eliza.json");
  process.env.ELIZA_CONFIG_PATH = configPath;
  process.env.ELIZA_STATE_DIR = root;
  delete process.env.ELIZA_API_TOKEN;
  delete process.env.ELIZA_CLOUD_PROVISIONED;
  delete process.env.ELIZA_REQUIRE_LOCAL_AUTH;
  delete process.env.ELIZA_RUNTIME_MODE;
  agentMocks.billing.mockClear();
  agentMocks.compat.mockClear();
  agentMocks.save.mockClear();
  cloudSecretMocks.get.mockClear();
  cloudSecretMocks.get.mockReturnValue(null);
});

afterEach(() => {
  process.env = originalEnv;
  fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
  resetDevCloudEnvAuthorityForTests();
});

describe("app-core Cloud config authority", () => {
  it("keeps persisted production topology and credentials out of billing and compat routes", async () => {
    const persisted = writeConfig({
      deploymentTarget: {
        runtime: "remote",
        remoteApiBase: PRODUCTION_API,
        remoteAccessToken: "persisted-production-access-token",
      },
      linkedAccounts: {
        elizacloud: { status: "linked" },
      },
      cloud: {
        enabled: true,
        baseUrl: PRODUCTION_API,
        apiKey: "persisted-production-key",
        serviceKey: "persisted-production-service-key",
      },
      env: {
        ELIZAOS_CLOUD_BASE_URL: PRODUCTION_API,
        ELIZAOS_CLOUD_API_KEY: "persisted-production-env-key",
      },
    });
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";
    process.env.ELIZAOS_CLOUD_BASE_URL = STAGING_API;
    process.env.ELIZAOS_CLOUD_API_KEY = "";

    const state = routeState("stale-runtime-production-key");
    expect(
      await handleElizaCompatRoute(
        trustedLoopbackRequest("/api/cloud/billing/summary"),
        responseStub(),
        state,
      ),
    ).toBe(true);
    expect(
      await handleElizaCompatRoute(
        trustedLoopbackRequest("/api/cloud/compat/agents"),
        responseStub(),
        state,
      ),
    ).toBe(true);

    const billingConfig = capturedConfig(agentMocks.billing);
    const compatConfig = capturedConfig(agentMocks.compat);
    for (const config of [billingConfig, compatConfig]) {
      expect(config?.deploymentTarget).toEqual({ runtime: "local" });
      expect(config?.cloud).toMatchObject({
        enabled: false,
        baseUrl: STAGING_API,
        apiKey: "",
      });
      expect(config?.cloud).not.toHaveProperty("serviceKey");
      expect(config?.linkedAccounts ?? {}).not.toHaveProperty("elizacloud");
      expect(config?.env ?? {}).not.toHaveProperty("ELIZAOS_CLOUD_BASE_URL");
      expect(config?.env ?? {}).not.toHaveProperty("ELIZAOS_CLOUD_API_KEY");
    }
    expect(agentMocks.billing).toHaveBeenCalledTimes(1);
    expect(agentMocks.compat).toHaveBeenCalledTimes(1);
    expect(agentMocks.save).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf8")).toBe(persisted);
  });

  it("retains linked-account key repair and persistence without dev authority", async () => {
    writeConfig({
      linkedAccounts: {
        elizacloud: { status: "linked" },
      },
      cloud: {
        enabled: true,
        baseUrl: PRODUCTION_API,
      },
    });
    delete process.env.ELIZA_DEV_SOURCE;
    delete process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY;
    process.env.ELIZAOS_CLOUD_API_KEY = "ambient-production-key";

    expect(
      await handleElizaCompatRoute(
        trustedLoopbackRequest("/api/cloud/billing/summary"),
        responseStub(),
        routeState(),
      ),
    ).toBe(true);

    expect(capturedConfig(agentMocks.billing)?.cloud).toMatchObject({
      baseUrl: PRODUCTION_API,
      apiKey: "ambient-production-key",
    });
    expect(agentMocks.save).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8")).cloud.apiKey).toBe(
      "ambient-production-key",
    );
  });

  it("does not backfill or save sealed and runtime credentials under authority", async () => {
    const persisted = writeConfig({
      linkedAccounts: {
        elizacloud: { status: "linked" },
      },
      cloud: {
        enabled: true,
        baseUrl: PRODUCTION_API,
      },
    });
    process.env.ELIZA_DEV_SOURCE = "1";
    process.env.ELIZA_DEV_CLOUD_ENV_AUTHORITY = "staging-default";
    process.env.ELIZAOS_CLOUD_BASE_URL = STAGING_API;
    process.env.ELIZAOS_CLOUD_API_KEY = "";
    cloudSecretMocks.get.mockReturnValue("sealed-production-key");

    expect(
      await handleElizaCompatRoute(
        trustedLoopbackRequest("/api/cloud/compat/agents"),
        responseStub(),
        routeState("runtime-production-key"),
      ),
    ).toBe(true);

    expect(capturedConfig(agentMocks.compat)?.cloud).toMatchObject({
      enabled: false,
      baseUrl: STAGING_API,
      apiKey: "",
    });
    expect(cloudSecretMocks.get).not.toHaveBeenCalled();
    expect(agentMocks.save).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf8")).toBe(persisted);
  });
});
