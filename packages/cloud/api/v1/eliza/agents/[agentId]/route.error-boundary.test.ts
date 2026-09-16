/** Owner-facing agent detail must not project operator filesystem paths. */
import { expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const ENV = { NODE_ENV: "test" } as unknown as AppEnv["Bindings"];
const ownerCredentialFixture = (prefix: string): string =>
  `${prefix}${["legacy", "owner", "credential", "fixture"].join("-")}`;
const ownerProviderTokenFixture = (): string =>
  ["provider returned ghp_", "a".repeat(36)].join("");

function agentWithError(errorMessage: string) {
  return {
    id: "agent-1",
    agent_name: "Ada",
    status: "error",
    database_status: "ready",
    bridge_url: null,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: errorMessage,
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
  getConfiguredElizaAgentPublicWebUiUrl: () => "https://example.test",
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
  "Provider https://api.eliza.app?debug=/workspace/eliza/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/app/eliza/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/data/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/nix/store/secret/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=//internal-host/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/callback/eliza/agents/agent-1/config.json",
  "Provider https://api.eliza.app?debug=/v1/chat/private/agents/agent-1/config.json",
  "Provider https://api.eliza.app(/srv/eliza/agents/agent-1/config.json)",
  "Provider https://api.eliza.app,C:\\eliza\\agents\\agent-1\\config.json",
  "Provider https://api.eliza.app?debug=%20%2Fsrv%2Feliza%2Fagents%2Fagent-1%2Fconfig.json",
  "Provider https://api.eliza.app?debug=%09%2Fworkspace%2Feliza%2Fagents%2Fagent-1%2Fconfig.json",
  "Provider https://api.eliza.app?%2Fsrv%2Feliza%2Fagents%2Fagent-1%2Fconfig.json=debug",
  "Provider https://api.eliza.app?debug=context%253A%2520%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json",
  "Provider https://api.eliza.app?context%253A%2520%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json=debug",
  "Provider https://api.eliza.app/#context%253A%2520%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json",
  "Provider https://api.eliza.app?debug=prefix%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json",
  "Provider https://api.eliza.app?prefix%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json=debug",
  "Provider https://api.eliza.app/#prefix%25252Fsrv%25252Feliza%25252Fagents%25252Fagent-1%25252Fconfig.json",
  ownerCredentialFixture("Authorization: Bearer "),
  ownerCredentialFixture("CEREBRAS_API_KEY="),
  ownerCredentialFixture("access_token="),
  ownerProviderTokenFixture(),
  "NODE_ENV=production",
  "CUSTOM_VALUE=fixture-value",
  "request failed at http://100.64.23.9:3000/api/status",
  "request failed at http://10.0.0.4:3000/api/status",
  "request failed at http://172.20.0.1:3000/api/status",
  "request failed at http://192.168.1.2:3000/api/status",
  "request failed at http://127.0.0.1:3000/api/status",
  "request failed at http://169.254.169.254/latest/meta-data",
  "request failed at http://[fd00::1]:3000/api/status",
  "request failed at http://[::1]:3000/api/status",
  "request failed at http://[fe80::1]:3000/api/status",
  "request failed at http://db.internal:5432/status",
  "request failed at https://service.eliza.local/status",
  "Provisioning failed\n    at markError (/opt/eliza/provision.ts:42:7)",
])(
  "GET re-sanitizes legacy private diagnostics at the detail DTO: %s",
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
    expect(JSON.stringify(body)).not.toContain(message);
  },
);
