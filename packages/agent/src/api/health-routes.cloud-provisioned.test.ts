/**
 * Hermetic integration for managed hosting detection through the real
 * runtime boundary the UI reads:
 *
 *   prepareManagedElizaBaseEnvironment()
 *     → container process env (producer map applied)
 *     → isCloudProvisionedContainer() (shared detector used by elizacloud)
 *     → handleHealthRoutes GET /api/status → cloud.cloudProvisioned
 *
 * Also covers self-hosted (no managed env) and bare-marker-without-credential
 * controls. Snapshots and restores every process.env key this suite mutates.
 */

import { mock } from "bun:test";
import type { AgentRuntime } from "@elizaos/core";
import { isCloudProvisionedContainer } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  type HealthRouteContext,
  handleHealthRoutes,
} from "./health-routes.ts";

// Mock the Cloud control-plane API-key mint used by the managed env producer so
// the agent package can call prepareManagedElizaBaseEnvironment without a DB.
mock.module(
  new URL("../../../cloud/shared/src/lib/services/api-keys.ts", import.meta.url)
    .href,
  () => ({
    apiKeysService: {
      createForAgent: async () => ({ plainKey: "agent-api-key" }),
    },
  }),
);

const { prepareManagedElizaBaseEnvironment } = await import(
  new URL(
    "../../../cloud/shared/src/lib/services/managed-eliza-config.ts",
    import.meta.url,
  ).href
);

function snapshotEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in snapshot)) {
      delete process.env[key];
    }
  }
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function applyProducerEnv(environmentVars: Record<string, string>): void {
  for (const [key, value] of Object.entries(environmentVars)) {
    process.env[key] = value;
  }
}

function clearManagedDetectionKeys(): void {
  for (const key of [
    "ELIZA_CLOUD_PROVISIONED",
    "ELIZA_API_TOKEN",
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZAOS_CLOUD_ENABLED",
    "STEWARD_AGENT_TOKEN",
  ]) {
    delete process.env[key];
  }
}

function makeStatusContext(agentName: string): {
  ctx: HealthRouteContext;
  responses: Array<{ data: unknown; status: number }>;
} {
  const responses: Array<{ data: unknown; status: number }> = [];
  const runtime = {
    plugins: [],
    getModel: () => undefined,
  } as unknown as AgentRuntime;
  const state = {
    runtime,
    config: { connectors: {} } as ElizaConfig,
    agentState: "running",
    agentName,
    model: undefined,
    startedAt: Date.now(),
    startup: { phase: "ready", attempt: 1 },
    plugins: [],
    pendingRestartReasons: [],
    connectorHealthMonitor: null,
  };
  return {
    responses,
    ctx: {
      req: {} as HealthRouteContext["req"],
      res: {} as HealthRouteContext["res"],
      method: "GET",
      pathname: "/api/status",
      url: new URL("http://127.0.0.1/api/status"),
      state,
      json: (_res, data, status = 200) => {
        responses.push({ data, status });
      },
      error: (_res, message, status = 500) => {
        responses.push({ data: { error: message }, status });
      },
    },
  };
}

describe("producer → detector → GET /api/status cloudProvisioned", () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    clearManagedDetectionKeys();
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it("managed producer map yields cloud.cloudProvisioned true on /api/status", async () => {
    const produced = await prepareManagedElizaBaseEnvironment({
      organizationId: "org-boundary-1",
      userId: "user-boundary-1",
      agentSandboxId: "managed-boundary-agent",
      existingEnv: {
        // Caller tries to clear the marker; producer must still force it on.
        ELIZA_CLOUD_PROVISIONED: "0",
      },
    });

    expect(produced.environmentVars.ELIZA_CLOUD_PROVISIONED).toBe("1");
    expect(produced.environmentVars.ELIZA_API_TOKEN?.length).toBeGreaterThan(0);

    // Control-plane container create injects the producer map as process env.
    applyProducerEnv(produced.environmentVars);

    // Real shared detector (same contract plugin-elizacloud / status use).
    expect(isCloudProvisionedContainer()).toBe(true);

    const { ctx, responses } = makeStatusContext("managed-boundary-agent");
    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe(200);
    expect(responses[0].data).toMatchObject({
      state: "running",
      agentName: "managed-boundary-agent",
      cloud: {
        cloudProvisioned: true,
        connectionStatus: "connected",
        activeAgentId: "managed-boundary-agent",
      },
    });
  });

  it("user-owned/self-hosted process without producer env reports false", async () => {
    expect(isCloudProvisionedContainer()).toBe(false);

    const { ctx, responses } = makeStatusContext("local-agent");
    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(responses[0].status).toBe(200);
    expect(responses[0].data).toMatchObject({
      cloud: {
        cloudProvisioned: false,
        connectionStatus: "disconnected",
        activeAgentId: null,
        hasApiKey: false,
      },
    });
  });

  it("bare managed marker without credentials stays unprovisioned", async () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    // No ELIZA_API_TOKEN / STEWARD_AGENT_TOKEN / cloud API key.

    expect(isCloudProvisionedContainer()).toBe(false);

    const { ctx, responses } = makeStatusContext("bare-marker-agent");
    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(responses[0].data).toMatchObject({
      cloud: {
        cloudProvisioned: false,
      },
    });
  });
});
