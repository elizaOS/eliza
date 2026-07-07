// Exercises cloud API v1 eliza agents agentid pairing token route.test behavior with deterministic Worker route fixtures.
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
  getElizaAgentDirectWebUiUrl: (sandbox: {
    headscale_ip?: string | null;
    web_ui_port?: number | null;
    bridge_port?: number | null;
  }) => {
    const port = sandbox.web_ui_port ?? sandbox.bridge_port;
    return sandbox.headscale_ip && port
      ? `http://${sandbox.headscale_ip}:${port}`
      : null;
  },
  getElizaAgentPublicWebUiUrl: (
    sandbox: { id: string },
    options?: { baseDomain?: string | null },
  ) => {
    if (!options?.baseDomain) return null;
    return `https://${sandbox.id}.${options.baseDomain}`;
  },
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

const checkAgentCreditGate = mock(async () => ({
  allowed: true,
  balance: 10,
  error: undefined as string | undefined,
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
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
    bridge_url: "http://168.119.244.189:19027",
    web_ui_port: 19028,
    bridge_port: 19027,
    headscale_ip: null,
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
    checkAgentCreditGate.mockClear();
    checkAgentCreditGate.mockResolvedValue({
      allowed: true,
      balance: 10,
      error: undefined,
    });
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
        redirectUrl: "http://168.119.244.189:19028/pair?token=pair-token",
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
        redirectUrl: "http://168.119.244.189:19028/pair?token=pair-token",
        expiresIn: 60,
      },
    });
  });

  test("skips a browser-unreachable tailnet headscale URL and falls back to the public managed hostname", async () => {
    // headscale IPs live on the 100.64/10 tailnet (CGNAT) our containers run on;
    // a browser can never reach one, so the direct-headscale rung is filtered and
    // the route must fall back to the public managed hostname (never a dead
    // http://100.64.x.x redirect).
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      bridge_url: null,
      headscale_ip: "100.64.0.12",
    });

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

  test("falls back to the managed web UI hostname when no direct UI route is stored", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      bridge_url: null,
      web_ui_port: null,
      bridge_port: null,
    });

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

  test("returns the bare Web UI origin when the agent does not support token pairing", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("custom"),
      environment_vars: {},
    });

    const response = await postPairingToken();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        token: "pair-token",
        redirectUrl: "http://168.119.244.189:19028",
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

  test("#11224: pairing a STOPPED shared-runtime agent does not credit-gate or provision", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("shared"),
      status: "stopped",
    });

    const response = await postPairingToken();

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      code: "AGENT_WEB_UI_NOT_READY",
    });
    expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
    expect(checkAgentCreditGate).not.toHaveBeenCalled();
    expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();
    expect(generateToken).not.toHaveBeenCalled();
  });

  test("#11224: pairing a STOPPED dedicated agent for a suspended org is blocked 402 — no free re-provision", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      status: "stopped",
    });
    checkAgentCreditGate.mockResolvedValueOnce({
      allowed: false,
      balance: 0,
      error: "Insufficient credits",
    });

    const response = await postPairingToken();

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      code: "insufficient_credits",
    });
    // The paid re-provision must NOT be enqueued for a suspended org.
    expect(enqueueAgentProvisionOnce).not.toHaveBeenCalled();
  });

  test("#11224: pairing a STOPPED dedicated agent for a FUNDED org still re-provisions (no regression)", async () => {
    findByIdAndOrg.mockResolvedValue({
      ...runningSandbox("dedicated-lazy"),
      status: "stopped",
    });
    checkAgentCreditGate.mockResolvedValue({
      allowed: true,
      balance: 10,
      error: undefined,
    });
    enqueueAgentProvisionOnce.mockResolvedValue({
      job: { id: "job-1" },
      created: true,
    });

    await postPairingToken();

    expect(checkAgentCreditGate).toHaveBeenCalledTimes(1);
    expect(enqueueAgentProvisionOnce).toHaveBeenCalledTimes(1);
  });
});
