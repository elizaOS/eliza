import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const requireAuthOrApiKeyWithOrg = mock(async () => ({
  user: { id: "user-1", organization_id: "org-1" },
}));
const findByIdAndOrg = mock();
const generateToken = mock(async () => "pair-token");
const enqueueAgentProvisionOnce = mock();
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));
let publicBaseDomain: string | undefined = "elizacloud.ai";

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg,
}));

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    findByIdAndOrg,
  },
}));

mock.module("@/lib/config/containers-env", () => ({
  containersEnv: {
    publicBaseDomain: () => publicBaseDomain,
  },
}));

mock.module("@/lib/eliza-agent-web-ui", () => ({
  getElizaAgentPublicWebUiUrl: (
    sandbox: { id: string },
    options?: { baseDomain?: string | null },
  ) => `https://${sandbox.id}.${options?.baseDomain ?? "elizacloud.ai"}`,
}));

mock.module("@/lib/services/pairing-token", () => ({
  getPairingTokenService: () => ({
    generateToken,
  }),
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvisionOnce,
  },
}));

mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody: () => ({
    success: false,
    error: "worker unavailable",
  }),
}));

mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    warn: mock(() => undefined),
  },
}));

const { default: pairingRoute } = await import("./route");

const app = new Hono();
app.route("/api/v1/eliza/agents/:agentId/pairing-token", pairingRoute);

function runningSandbox(executionTier: "custom" | "dedicated-lazy" | "shared") {
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    organization_id: "org-1",
    user_id: "user-1",
    agent_name: "bnancy",
    status: "running",
    execution_tier: executionTier,
    environment_vars: { ELIZA_API_TOKEN: "agent-token" },
    updated_at: new Date("2026-06-04T12:00:00.000Z"),
  };
}

async function postPairingToken() {
  return app.fetch(
    new Request(
      "https://api.example.test/api/v1/eliza/agents/e06bb509-6c52-4c33-a9f7-66addc43e8c8/pairing-token",
      { method: "POST" },
    ),
  );
}

describe("eliza agent pairing token route", () => {
  beforeEach(() => {
    requireAuthOrApiKeyWithOrg.mockClear();
    findByIdAndOrg.mockReset();
    generateToken.mockClear();
    enqueueAgentProvisionOnce.mockClear();
    checkProvisioningWorkerHealth.mockClear();
    publicBaseDomain = "elizacloud.ai";
  });

  test("redirects custom-image agents with managed tokens through the pairing page", async () => {
    findByIdAndOrg.mockResolvedValue(runningSandbox("custom"));

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        token: "pair-token",
        redirectUrl:
          "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai/pair?token=pair-token",
        expiresIn: 60,
      },
    });
  });

  test("redirects managed runtimes through the pairing page", async () => {
    findByIdAndOrg.mockResolvedValue(runningSandbox("dedicated-lazy"));

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        token: "pair-token",
        redirectUrl:
          "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai/pair?token=pair-token",
        expiresIn: 60,
      },
    });
  });

  test("uses the default web UI base domain when no runtime override is configured", async () => {
    publicBaseDomain = undefined;
    findByIdAndOrg.mockResolvedValue(runningSandbox("dedicated-lazy"));

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        token: "pair-token",
        redirectUrl:
          "https://e06bb509-6c52-4c33-a9f7-66addc43e8c8.elizacloud.ai/pair?token=pair-token",
        expiresIn: 60,
      },
    });
  });

  test("does not issue web UI redirects for shared-runtime agents", async () => {
    findByIdAndOrg.mockResolvedValue(runningSandbox("shared"));

    const response = await postPairingToken();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "AGENT_WEB_UI_NOT_READY",
    });
    expect(generateToken).not.toHaveBeenCalled();
  });
});
