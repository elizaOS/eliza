/**
 * Verifies the owned agent-detail response separates the public owner contract
 * from role-gated infrastructure diagnostics. Deterministic Worker route
 * fixtures exercise the real canonical-host helper; no database or network.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  AGENT_EXECUTION_TIERS,
  AGENT_SANDBOX_STATUSES,
} from "@elizaos/shared/contracts/cloud-agent-lifecycle";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
const getAgent = mock();
const getAdminStatusForUser = mock(async () => ({ isAdmin: false }));
const getActiveAgentLifecycleJobsForOrg = mock(async () => []);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: { getAgent },
}));

mock.module("@/lib/services/admin", () => ({
  adminService: { getAdminStatusForUser },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: { getActiveAgentLifecycleJobsForOrg },
}));

mock.module("@/lib/services/steward-client", () => ({
  getStewardAgent: mock(async () => null),
}));

mock.module("@/db/repositories/characters", () => ({
  userCharactersRepository: {
    findByIdInOrganization: mock(async () => null),
  },
}));

mock.module("@/db/client", () => ({
  db: {
    query: {
      agentServerWallets: { findFirst: mock(async () => null) },
    },
  },
}));

mock.module("@/db/schemas/agent-server-wallets", () => ({
  agentServerWallets: { character_id: "character_id" },
}));

mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) =>
    Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "error",
      },
      { status: 500 },
    ),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(() => undefined),
    warn: mock(() => undefined),
  },
}));

const { default: agentDetailRoute } = await import("./route");

const app = new Hono<AppEnv>();
app.route("/api/v1/eliza/agents/:agentId", agentDetailRoute);

const AGENT_ID = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";

interface DetailResponseBody {
  success: boolean;
  data: Record<string, unknown> & {
    adminDetails: Record<string, unknown> | null;
    webUiUrl: string | null;
  };
}

function dedicatedAgent() {
  return {
    id: AGENT_ID,
    organization_id: "org-1",
    user_id: "user-1",
    character_id: null,
    agent_name: "Private Address Contract",
    status: "running",
    database_status: "ready",
    bridge_url: "http://100.64.0.12:19027",
    health_url: "http://10.0.0.8:19028/health",
    headscale_ip: "100.64.0.12",
    bridge_port: 19027,
    web_ui_port: 19028,
    node_id: "hetzner-node-1",
    container_name: "eliza-private-contract",
    docker_image: "registry.example/eliza:test",
    execution_tier: "dedicated-lazy",
    agent_config: {},
    error_message: null,
    error_count: 0,
    last_backup_at: null,
    last_heartbeat_at: new Date("2026-08-23T12:00:00.000Z"),
    created_at: new Date("2026-08-22T12:00:00.000Z"),
    updated_at: new Date("2026-08-23T12:00:00.000Z"),
  };
}

async function getDetail(canonicalAgentBaseDomain?: string) {
  return app.fetch(
    new Request(`https://api.example.test/api/v1/eliza/agents/${AGENT_ID}`),
    {
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: canonicalAgentBaseDomain,
    } as AppEnv["Bindings"],
  );
}

describe("owned agent detail private-address contract", () => {
  beforeEach(() => {
    getAgent.mockReset();
    getAgent.mockResolvedValue(dedicatedAgent());
    getAdminStatusForUser.mockReset();
    getAdminStatusForUser.mockResolvedValue({ isAdmin: false });
    getActiveAgentLifecycleJobsForOrg.mockClear();
  });

  test("ordinary owner receives only the canonical public gateway", async () => {
    const response = await getDetail("staging.elizacloud.ai");
    const body = (await response.json()) as DetailResponseBody;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: {
        id: AGENT_ID,
        webUiUrl: `https://${AGENT_ID}.staging.elizacloud.ai`,
        adminDetails: null,
      },
    });
    expect(body.data).not.toHaveProperty("bridgeUrl");
    expect(JSON.stringify(body)).not.toMatch(/100\.64|10\.0|192\.168/);
  });

  test("authorized admin receives explicitly separated internal diagnostics", async () => {
    getAdminStatusForUser.mockResolvedValue({ isAdmin: true });

    const response = await getDetail("staging.elizacloud.ai");
    const body = (await response.json()) as DetailResponseBody;

    expect(response.status).toBe(200);
    expect(body.data).not.toHaveProperty("bridgeUrl");
    expect(body.data.adminDetails).toMatchObject({
      internalBridgeUrl: "http://100.64.0.12:19027",
      headscaleIp: "100.64.0.12",
      sshCommand: "ssh root@100.64.0.12",
      webUiUrl: `https://${AGENT_ID}.staging.elizacloud.ai`,
    });
  });

  test.each([undefined, "", "100.64.0.99", "headscale.internal"])(
    "missing or invalid gateway host %p does not fabricate a public URL",
    async (baseDomain) => {
      const response = await getDetail(baseDomain);
      const body = (await response.json()) as DetailResponseBody;

      expect(response.status).toBe(200);
      expect(body.data.webUiUrl).toBeNull();
      expect(body.data).not.toHaveProperty("bridgeUrl");
      expect(JSON.stringify(body)).not.toMatch(/100\.64|10\.0|192\.168/);
    },
  );

  test.each(AGENT_SANDBOX_STATUSES)(
    "returns canonical sandbox status %s without translation",
    async (status) => {
      getAgent.mockResolvedValue({ ...dedicatedAgent(), status });

      const response = await getDetail("staging.elizacloud.ai");
      const body = (await response.json()) as DetailResponseBody;

      expect(response.status).toBe(200);
      expect(body.data.status).toBe(status);
    },
  );

  test.each(AGENT_EXECUTION_TIERS)(
    "returns canonical execution tier %s without translation",
    async (executionTier) => {
      getAgent.mockResolvedValue({
        ...dedicatedAgent(),
        execution_tier: executionTier,
      });

      const response = await getDetail("staging.elizacloud.ai");
      const body = (await response.json()) as DetailResponseBody;

      expect(response.status).toBe(200);
      expect(body.data.executionTier).toBe(executionTier);
    },
  );
});
