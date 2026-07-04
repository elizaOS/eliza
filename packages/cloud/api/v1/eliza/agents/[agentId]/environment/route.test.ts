// Exercises cloud API v1 eliza agents agentid environment route.test behavior with deterministic Worker route fixtures.
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
}));
const getAgentForWrite = mock();
const updateAgentEnvironment = mock();
const loggerInfo = mock(() => undefined);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    getAgentForWrite,
    updateAgentEnvironment,
  },
}));

mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: loggerInfo,
  },
}));

const { default: environmentRoute } = await import("./route");

const app = new Hono();
app.route("/api/v1/eliza/agents/:agentId/environment", environmentRoute);

function runningAgent() {
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    organization_id: "org-1",
    status: "running",
    execution_tier: "custom",
    environment_vars: {
      DATABASE_URL: "postgres://existing",
      PUBLIC_BASE_URL: "https://old.example",
      REMOVE_ME: "yes",
    },
  };
}

async function patchEnvironment(body: unknown) {
  return app.fetch(
    new Request(
      "https://api.example.test/api/v1/eliza/agents/e06bb509-6c52-4c33-a9f7-66addc43e8c8/environment",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    ),
  );
}

describe("eliza agent environment route", () => {
  beforeEach(() => {
    requireAuthOrApiKeyWithOrg.mockClear();
    getAgentForWrite.mockReset();
    updateAgentEnvironment.mockReset();
    loggerInfo.mockClear();
  });

  test("merges environment updates without returning secret values", async () => {
    const agent = runningAgent();
    getAgentForWrite.mockResolvedValue(agent);
    updateAgentEnvironment.mockResolvedValue({
      ...agent,
      environment_vars: {
        DATABASE_URL: "postgres://existing",
        PUBLIC_BASE_URL: "https://old.example",
        CUSTOM_GREETING: "gm",
      },
    });

    const response = await patchEnvironment({
      environmentVars: {
        CUSTOM_GREETING: "gm",
        REMOVE_ME: null,
      },
    });

    expect(response.status).toBe(200);
    expect(updateAgentEnvironment).toHaveBeenCalledWith(
      "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
      "org-1",
      {
        DATABASE_URL: "postgres://existing",
        PUBLIC_BASE_URL: "https://old.example",
        CUSTOM_GREETING: "gm",
      },
    );
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        agentId: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
        updatedKeys: ["CUSTOM_GREETING"],
        removedKeys: ["REMOVE_ME"],
        status: "running",
        executionTier: "custom",
        needsRestart: true,
      },
    });
  });

  test("rejects invalid environment variable names", async () => {
    const response = await patchEnvironment({
      environmentVars: {
        "BAD-NAME": "value",
      },
    });

    expect(response.status).toBe(400);
    expect(updateAgentEnvironment).not.toHaveBeenCalled();
  });

  test("rejects reserved managed environment keys", async () => {
    const response = await patchEnvironment({
      environmentVars: {
        DATABASE_URL: "postgres://replacement",
        ELIZA_API_TOKEN: null,
        PUBLIC_BASE_URL: "https://replacement.example",
      },
    });

    expect(response.status).toBe(400);
    expect(updateAgentEnvironment).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Reserved environment variables cannot be patched",
      reservedKeys: ["DATABASE_URL", "ELIZA_API_TOKEN", "PUBLIC_BASE_URL"],
    });
  });

  test("returns not found for an agent outside the organization", async () => {
    getAgentForWrite.mockResolvedValue(null);

    const response = await patchEnvironment({
      environmentVars: {
        CUSTOM_GREETING: "gm",
      },
    });

    expect(response.status).toBe(404);
    expect(updateAgentEnvironment).not.toHaveBeenCalled();
  });
});
