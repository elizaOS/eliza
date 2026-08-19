/** Exercises GitHub OAuth popup-return flag validation at the redirect boundary. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const createLifeOpsGithubReturnResponse = mock(
  (_args: { postMessage: boolean }) => new Response("popup"),
);
const findByIdAndOrg = mock(async () => null);
const connectAgent = mock(async () => ({ restarted: false }));
const getConnection = mock(async () => null);
const readManagedAgentGithubBinding = mock(() => null);

mock.module("@/lib/services/agent-github-return", () => ({
  createLifeOpsGithubReturnResponse,
  normalizePostMessageTargetOrigin: (value: string) => new URL(value).origin,
}));
mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: { findByIdAndOrg },
}));
mock.module("@/lib/services/agent-managed-github", () => ({
  managedAgentGithubService: { connectAgent },
}));
mock.module("@/lib/services/eliza-agent-config", () => ({
  readManagedAgentGithubBinding,
}));
mock.module("@/lib/services/oauth", () => ({
  oauthService: { getConnection },
}));
mock.module("@/lib/utils/logger", () => ({
  logger: {
    warn: mock(),
    error: mock(),
    info: mock(),
  },
}));

const route = (await import("./route")).default;
const app = new Hono<AppEnv>();
app.route("/api/v1/eliza/github-oauth-complete", route);

const ENV = {
  NEXT_PUBLIC_APP_URL: "https://app.example.test",
} as unknown as AppEnv["Bindings"];

function complete(query = "") {
  return app.request(`/api/v1/eliza/github-oauth-complete${query}`, {}, ENV);
}

describe("GET /api/v1/eliza/github-oauth-complete post_message identity", () => {
  beforeEach(() => {
    createLifeOpsGithubReturnResponse.mockClear();
    findByIdAndOrg.mockClear();
    connectAgent.mockClear();
    getConnection.mockClear();
    readManagedAgentGithubBinding.mockClear();
  });

  test.each(["", "?post_message="])(
    "accepts %s as the dashboard-redirect completion path",
    async (query) => {
      const response = await complete(query);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(
        "/cloud/settings?tab=agents",
      );
      expect(createLifeOpsGithubReturnResponse).not.toHaveBeenCalled();
      expect(findByIdAndOrg).not.toHaveBeenCalled();
      expect(connectAgent).not.toHaveBeenCalled();
    },
  );

  test("accepts post_message=1 as the popup postMessage completion path", async () => {
    const response = await complete("?post_message=1");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("popup");
    expect(createLifeOpsGithubReturnResponse).toHaveBeenCalledTimes(1);
    const args = createLifeOpsGithubReturnResponse.mock.calls[0]?.[0] as {
      postMessage: boolean;
    };
    expect(args.postMessage).toBe(true);
    expect(findByIdAndOrg).not.toHaveBeenCalled();
    expect(connectAgent).not.toHaveBeenCalled();
  });

  test.each(["true", "TRUE", "0", "false", "yes", "foo", "1e2"])(
    "rejects post_message=%s before GitHub linking",
    async (token) => {
      const response = await complete(
        `?post_message=${encodeURIComponent(token)}&agent_id=agent-1&org_id=org-1&user_id=user-1&connection_id=conn-1&github_connected=true`,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("Invalid post_message");
      expect(createLifeOpsGithubReturnResponse).not.toHaveBeenCalled();
      expect(findByIdAndOrg).not.toHaveBeenCalled();
      expect(connectAgent).not.toHaveBeenCalled();
      expect(getConnection).not.toHaveBeenCalled();
    },
  );

  test.each([
    "?post_message=1&post_message=1",
    "?post_message=1&post_message=0",
    "?post_message=&post_message=1",
    "?post_message=foo&post_message=1",
  ])(
    "rejects duplicate post_message values in %s before GitHub linking",
    async (query) => {
      const response = await complete(`${query}&agent_id=agent-1`);
      expect(response.status).toBe(400);
      expect(createLifeOpsGithubReturnResponse).not.toHaveBeenCalled();
      expect(findByIdAndOrg).not.toHaveBeenCalled();
      expect(connectAgent).not.toHaveBeenCalled();
    },
  );
});
