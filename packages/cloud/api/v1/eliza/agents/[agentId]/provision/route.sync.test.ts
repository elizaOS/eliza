/**
 * POST /api/v1/eliza/agents/:id/provision `sync` is provision-wait identity,
 * leftover tax after agent-resume sync (#21099). Stock develop treated any
 * non-exact `true` token as async, so `sync=TRUE` still enqueued a 202 job
 * instead of the blocking fallback. Credit / warm-pool / enqueue parsers
 * stay untouched.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));

const ORG_A = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "agent-provision-1";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

const getAgentForWrite = mock(
  async (): Promise<{
    id: string;
    organization_id: string;
    agent_name: string;
    execution_tier: string;
    status: string;
    bridge_url: string | null;
    health_url: string | null;
  }> => ({
    id: AGENT_ID,
    organization_id: ORG_A,
    agent_name: "already-up",
    execution_tier: "dedicated-always",
    status: "running",
    bridge_url: "https://bridge.example.test",
    health_url: "https://health.example.test",
  }),
);
const provision = mock(async () => ({
  success: true,
  bridgeUrl: "https://bridge.example.test",
  healthUrl: "https://health.example.test",
  sandboxRecord: {
    id: AGENT_ID,
    agent_name: "provisioned-agent",
    status: "running",
  },
}));
const checkAgentCreditGate = mock(async () => ({
  allowed: true,
  balance: 5,
  error: "",
}));
const enqueueAgentProvision = mock(async () => ({
  job: { id: "job-1", status: "queued" },
  created: true,
}));
const triggerImmediate = mock(async () => undefined);
const checkProvisioningWorkerHealth = mock(async () => ({ ok: true }));
const claimWarmContainer = mock(async () => null);

mock.module("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: "user-1", organization_id: ORG_A },
  }),
}));
mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate,
}));
mock.module("@/lib/services/agent-billing-gate-402", () => ({
  insufficientCredits402: () => ({ error: "insufficient credits" }),
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgentForWrite, provision },
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: { enqueueAgentProvision, triggerImmediate },
}));
mock.module("@/lib/services/provisioning-worker-health", () => ({
  checkProvisioningWorkerHealth,
  provisioningWorkerFailureBody: () => ({ error: "worker" }),
}));
mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));
mock.module("@/lib/api/errors", () => ({
  errorToResponse: (error: unknown) =>
    Response.json(
      { error: error instanceof Error ? error.message : "error" },
      { status: 500 },
    ),
}));
mock.module("@/lib/security/outbound-url", () => ({
  assertSafeOutboundUrl: async () => undefined,
}));
mock.module("@/lib/config/containers-env", () => ({
  containersEnv: {
    warmPoolEnabled: () => false,
    defaultAgentImage: () => "eliza-agent:test",
  },
}));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { claimWarmContainer },
}));

const { default: provisionRoute } = await import("./route");

function buildApp() {
  const app = new Hono<AppEnv>();
  app.route("/api/v1/eliza/agents/:agentId/provision", provisionRoute);
  return app;
}

function post(query = "") {
  return buildApp().request(
    `/api/v1/eliza/agents/${AGENT_ID}/provision${query}`,
    { method: "POST" },
    ENV,
  );
}

describe("POST /api/v1/eliza/agents/:id/provision sync identity", () => {
  beforeEach(() => {
    getAgentForWrite.mockClear();
    provision.mockClear();
    checkAgentCreditGate.mockClear();
    enqueueAgentProvision.mockClear();
    triggerImmediate.mockClear();
    checkProvisioningWorkerHealth.mockClear();
    claimWarmContainer.mockClear();
  });

  test.each(["", "?sync=", "?sync=false"])(
    "accepts %s as async provision (already-running fast path)",
    async (query) => {
      const response = await post(query);
      expect(response.status).toBe(200);
      expect(getAgentForWrite).toHaveBeenCalledTimes(1);
      expect(provision).not.toHaveBeenCalled();
      expect(enqueueAgentProvision).not.toHaveBeenCalled();
    },
  );

  test("accepts sync=true and runs the blocking provision path", async () => {
    getAgentForWrite.mockImplementationOnce(async () => ({
      id: AGENT_ID,
      organization_id: ORG_A,
      agent_name: "needs-provisioning",
      execution_tier: "dedicated-always",
      status: "stopped",
      bridge_url: null,
      health_url: null,
    }));
    const response = await post("?sync=true");
    expect(response.status).toBe(200);
    expect(getAgentForWrite).toHaveBeenCalledTimes(1);
    expect(checkAgentCreditGate).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledTimes(1);
    expect(provision).toHaveBeenCalledWith(AGENT_ID, ORG_A);
    expect(enqueueAgentProvision).not.toHaveBeenCalled();
  });

  test.each(["FALSE", "TRUE", "0", "1", "no", "yes", "foo", "1e2"])(
    "rejects sync=%s before lookup, credit gate, provision, and enqueue",
    async (token) => {
      const response = await post(`?sync=${encodeURIComponent(token)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid sync");
      expect(getAgentForWrite).not.toHaveBeenCalled();
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(enqueueAgentProvision).not.toHaveBeenCalled();
      expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
      expect(triggerImmediate).not.toHaveBeenCalled();
      expect(claimWarmContainer).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?sync=false&sync=true",
    "?sync=true&sync=false",
    "?sync=true&sync=true",
    "?sync=&sync=false",
  ])(
    "rejects ambiguous duplicate query %s without side effects",
    async (query) => {
      const response = await post(query);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "Invalid sync" });
      expect(getAgentForWrite).not.toHaveBeenCalled();
      expect(checkAgentCreditGate).not.toHaveBeenCalled();
      expect(provision).not.toHaveBeenCalled();
      expect(enqueueAgentProvision).not.toHaveBeenCalled();
      expect(checkProvisioningWorkerHealth).not.toHaveBeenCalled();
      expect(triggerImmediate).not.toHaveBeenCalled();
      expect(claimWarmContainer).not.toHaveBeenCalled();
    },
  );
});
