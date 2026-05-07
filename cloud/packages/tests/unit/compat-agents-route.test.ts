import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Hono } from "hono";

const TEST_USER = { id: "u1", organization_id: "o1" };

function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function loadCompatAgentsRoute(): Promise<Hono> {
  const { Hono } = await import("hono");
  const mod = await import(
    new URL(
      `../../../apps/api/compat/agents/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const inner = mod.default as Hono;
  const parent = new Hono();
  parent.route("/api/compat/agents", inner);
  return parent;
}

describe("compat agents route", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalControlPlaneUrl = process.env.CONTAINER_CONTROL_PLANE_URL;
  const originalRequireProvisioningWorker = process.env.REQUIRE_PROVISIONING_WORKER;

  beforeEach(() => {
    mock.restore();
    process.env.NODE_ENV = "test";
    restoreOptionalEnv("CONTAINER_CONTROL_PLANE_URL", originalControlPlaneUrl);
    restoreOptionalEnv("REQUIRE_PROVISIONING_WORKER", originalRequireProvisioningWorker);
  });

  afterEach(() => {
    mock.restore();
    restoreOptionalEnv("NODE_ENV", originalNodeEnv);
    restoreOptionalEnv("CONTAINER_CONTROL_PLANE_URL", originalControlPlaneUrl);
    restoreOptionalEnv("REQUIRE_PROVISIONING_WORKER", originalRequireProvisioningWorker);
  });

  test("fails closed before create when auto-provisioning requires an unavailable worker", async () => {
    process.env.REQUIRE_PROVISIONING_WORKER = "true";
    delete process.env.CONTAINER_CONTROL_PLANE_URL;
    const createCalls: unknown[] = [];

    mock.module("@/lib/auth/service-key-hono-worker", () => ({
      validateServiceKey: async () => null,
    }));
    mock.module("@/lib/auth/waifu-bridge", () => ({
      authenticateWaifuBridge: async () => null,
    }));
    mock.module("@/lib/auth/workers-hono-auth", () => ({
      requireUserOrApiKeyWithOrg: async () => TEST_USER,
    }));
    mock.module("@/lib/services/eliza-agent-config", () => ({
      AGENT_CHARACTER_OWNERSHIP_KEY: "__agentCharacterOwnership",
      AGENT_INTERNAL_CONFIG_PREFIX: "__agent",
      AGENT_MANAGED_DISCORD_GATEWAY_KEY: "__agentManagedDiscordGateway",
      AGENT_MANAGED_DISCORD_KEY: "__agentManagedDiscord",
      AGENT_MANAGED_GITHUB_KEY: "__agentManagedGithub",
      AGENT_REUSE_EXISTING_CHARACTER: "reuse-existing",
      reusesExistingElizaCharacter: () => false,
      stripReservedElizaConfigKeys: (value: unknown) => value,
      withReusedElizaCharacterOwnership: (value: unknown) => value,
    }));
    mock.module("@/lib/services/eliza-sandbox", () => ({
      elizaSandboxService: {
        listAgents: async () => [],
        createAgent: async (params: unknown) => {
          createCalls.push(params);
          return {
            id: "agent-1",
            agent_name: "My Agent",
            status: "pending",
            created_at: new Date("2026-01-01T00:00:00.000Z"),
            updated_at: new Date("2026-01-01T00:00:00.000Z"),
          };
        },
      },
    }));
    mock.module("@/lib/services/provisioning-jobs", () => ({
      provisioningJobService: {
        enqueueAgentProvisionOnce: async () => {
          throw new Error("should not enqueue when worker is unavailable");
        },
      },
    }));
    mock.module("@/lib/utils/logger", () => ({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }));

    const app = await loadCompatAgentsRoute();
    const res = await app.request(
      "https://elizacloud.ai/api/compat/agents",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer eliza_test_key",
        },
        body: JSON.stringify({ agentName: "My Agent" }),
      },
      { WAIFU_AUTO_PROVISION: "true" },
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      success: false,
      code: "PROVISIONING_WORKER_NOT_CONFIGURED",
      error:
        "Agent provisioning worker is not configured. Set CONTAINER_CONTROL_PLANE_URL before accepting provisioning requests.",
      retryable: true,
    });
    expect(createCalls).toEqual([]);
  });
});
