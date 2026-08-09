/**
 * Runtime-boundary coverage for GET /api/status `cloud.cloudProvisioned`.
 * Proves the managed hosting marker + credential contract reaches the status
 * payload the UI reads, and that a user-owned/self-hosted process without the
 * marker reports false. Uses the real isCloudProvisionedContainer detector via
 * plugin-elizacloud (no mock of the system under test).
 */

import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ElizaConfig } from "../config/config.ts";
import {
  type HealthRouteContext,
  handleHealthRoutes,
} from "./health-routes.ts";

const CLOUD_ENV_KEYS = [
  "ELIZA_CLOUD_PROVISIONED",
  "ELIZA_API_TOKEN",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
  "STEWARD_AGENT_TOKEN",
] as const;

function makeStatusContext(): {
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
    agentName: "managed-test-agent",
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

describe("GET /api/status cloud.cloudProvisioned (managed vs user-owned)", () => {
  const savedEnv = Object.fromEntries(
    CLOUD_ENV_KEYS.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    for (const key of CLOUD_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reports cloudProvisioned true when the managed marker and a credential are present", async () => {
    // Mirrors prepareManagedElizaBaseEnvironment + control-plane injection:
    // flag is forced on, and a platform token is always present.
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    process.env.ELIZA_API_TOKEN = "agent_test_token_not_a_secret";

    const { ctx, responses } = makeStatusContext();
    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe(200);
    expect(responses[0].data).toMatchObject({
      state: "running",
      agentName: "managed-test-agent",
      cloud: {
        cloudProvisioned: true,
        connectionStatus: "connected",
        activeAgentId: "managed-test-agent",
      },
    });
  });

  it("reports cloudProvisioned false for a user-owned/self-hosted process", async () => {
    // No ELIZA_CLOUD_PROVISIONED and no cloud credentials — the default local
    // install shape. Flag alone without a credential must also stay false, but
    // the self-hosted path is the complete absence of managed env.
    const { ctx, responses } = makeStatusContext();
    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(responses).toHaveLength(1);
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

  it("does not treat a bare managed marker without credentials as provisioned", async () => {
    process.env.ELIZA_CLOUD_PROVISIONED = "1";
    // No ELIZA_API_TOKEN / STEWARD_AGENT_TOKEN / cloud API key.

    const { ctx, responses } = makeStatusContext();
    await expect(handleHealthRoutes(ctx)).resolves.toBe(true);

    expect(responses[0].data).toMatchObject({
      cloud: {
        cloudProvisioned: false,
      },
    });
  });
});
