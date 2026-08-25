/** Owner-facing agent detail must not project operator filesystem paths. */
import { expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];

function agentWithError(errorMessage: string) {
  return {
    id: "agent-1",
    agent_name: "Ada",
    status: "error",
    database_status: "ready",
    bridge_url: null,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: `${errorMessage}\n    at readAgentConfig (/opt/eliza/provision.ts:42:7)`,
    error_count: 1,
    created_at: new Date("2026-08-21T00:00:00.000Z"),
    updated_at: new Date("2026-08-21T00:01:00.000Z"),
    character_id: null,
    node_id: null,
    container_name: null,
    headscale_ip: null,
    bridge_port: null,
    web_ui_port: null,
    docker_image: null,
    agent_config: {},
    execution_tier: "dedicated-always" as const,
  };
}

const getAgent = mock(async () =>
  agentWithError("ENOENT [/srv/eliza/agents/agent-1/config.json]"),
);

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    error: mock(() => undefined),
  },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: async () => ({
    id: "user-1",
    organization_id: ORG_ID,
  }),
}));
mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    getAgent,
  },
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
  failureResponse: (c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ success: false, error: "internal" }, 500),
}));
mock.module("@/lib/config/containers-env", () => ({
  containersEnv: { publicBaseDomain: () => null },
}));
mock.module("@/lib/eliza-agent-web-ui", () => ({
  getElizaAgentPublicWebUiUrl: () => "https://example.test",
}));
mock.module("@/lib/services/admin", () => ({
  adminService: {
    getAdminStatusForUser: mock(async () => ({ isAdmin: false })),
  },
}));
mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    getActiveAgentLifecycleJobsForOrg: mock(async () => []),
  },
}));
mock.module("@/lib/services/steward-client", () => ({
  getStewardAgent: mock(async () => null),
}));

const { default: agentDetailRoute } = await import("./route");

test.each([
  "ENOENT [/srv/eliza/agents/agent-1/config.json]",
  "ENOENT: //srv/eliza/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/srv/eliza/agents/agent-1/config.json",
  "Provider https://api.eliza.app(/srv/eliza/agents/agent-1/config.json)",
  "Provider https://api.eliza.app,C:\\eliza\\agents\\agent-1\\config.json",
])(
  "GET withholds formatted server paths from the detail DTO: %s",
  async (message) => {
    getAgent.mockImplementationOnce(async () => agentWithError(message));
    const app = new Hono<AppEnv>();
    app.route("/api/v1/eliza/agents/:agentId", agentDetailRoute);

    const response = await app.request("/api/v1/eliza/agents/agent-1", {}, ENV);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { errorMessage: string | null };
    };
    expect(body.data.errorMessage).toBe(
      "The operation failed. Retry from Eliza Cloud or contact support if it continues.",
    );
    expect(JSON.stringify(body)).not.toContain("agent-1/config.json");
    expect(JSON.stringify(body)).not.toContain("/opt/eliza");
  },
);
