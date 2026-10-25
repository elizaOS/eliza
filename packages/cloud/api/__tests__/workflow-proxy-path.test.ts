/**
 * The workflow proxy must keep every forwarded request under
 * /agents/<checked id>/workflows/ on the agent server, and must not pass the
 * caller's credentials on. Real wildcard route as the generated router mounts
 * it; the caller, the agent lookup, Redis and the agent-server fetch are
 * replaced.
 */
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";

process.env.NODE_ENV = "test";
process.env.MOCK_REDIS = "1";

const ORG = "11111111-1111-4111-8111-1111111111e1";
const USER = "22222222-2222-4222-8222-2222222222e1";
const OWN_AGENT = "33333333-3333-4333-8333-3333333333e1";
const OTHER_AGENT = "33333333-3333-4333-8333-3333333333e2";

const realLibAuth = { ...(await import("@elizaos/cloud-shared/lib/auth")) };
mock.module("@elizaos/cloud-shared/lib/auth", () => ({
  ...realLibAuth,
  requireAuthOrApiKeyWithOrg: async () => ({
    user: { id: USER, organization_id: ORG },
  }),
}));
const realRedisFactory = {
  ...(await import("@elizaos/cloud-shared/lib/cache/redis-factory")),
};
mock.module("@elizaos/cloud-shared/lib/cache/redis-factory", () => ({
  ...realRedisFactory,
  buildRedisClient: () => ({
    get: async (key: string) =>
      key === `agent:${OWN_AGENT}:server`
        ? "agent-server-1"
        : key === "server:agent-server-1:url"
          ? "http://agent-server.internal"
          : null,
  }),
}));
const { elizaSandboxService } = await import(
  "@elizaos/cloud-shared/lib/services/eliza-sandbox"
);
spyOn(elizaSandboxService, "getAgent").mockImplementation((async (
  agentId: string,
  organizationId: string,
) =>
  agentId === OWN_AGENT && organizationId === ORG
    ? {
        id: OWN_AGENT,
        execution_tier: "dedicated",
        status: "running",
        bridge_url: "http://bridge",
        health_url: "http://health",
      }
    : undefined) as never);

const forwarded: Array<{ url: string; headers: Headers; method: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  forwarded.push({
    url: String(input),
    headers: new Headers(init?.headers),
    method: init?.method ?? "GET",
  });
  return Response.json({ ok: true });
}) as typeof fetch;

const { Hono } = await import("hono");
const { default: workflowPathRoute } = await import(
  "../v1/eliza/agents/[agentId]/workflows/[...path]/route"
);
const app = new Hono().route(
  "/api/v1/eliza/agents/:agentId/workflows/:*{.+}",
  workflowPathRoute,
);
const env = {
  NODE_ENV: "test",
  RATE_LIMIT_DISABLED: "true",
  AGENT_SERVER_SHARED_SECRET: "server-secret",
};

beforeEach(() => {
  forwarded.length = 0;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

test.each([
  ["DELETE", `..%2F..%2F${OTHER_AGENT}`],
  ["POST", `..%2F..%2F${OTHER_AGENT}%2Fother`],
  ["POST", "x/..%2F..%2Fother"],
  ["POST", "..%2F..%2F..%2Fother"],
])(
  "%s with a dot segment in the path is refused before anything is forwarded (%s)",
  async (method, suffix) => {
    const response = await app.request(
      `/api/v1/eliza/agents/${OWN_AGENT}/workflows/${suffix}`,
      { method, headers: { "content-type": "application/json" }, body: "{}" },
      env,
    );

    expect(response.status).toBe(400);
    expect(forwarded).toEqual([]);
  },
);

test("a workflow path is forwarded under the agent's workflows, without the caller's credentials", async () => {
  const response = await app.request(
    `/api/v1/eliza/agents/${OWN_AGENT}/workflows/abc/run`,
    {
      method: "GET",
      headers: {
        cookie: "session=caller",
        authorization: "Bearer caller-key",
        "x-api-key": "caller-api-key",
        "x-eliza-agent-owner-id": "someone-else",
      },
    },
    env,
  );

  expect(response.status).toBe(200);
  expect(forwarded.map((call) => call.url)).toEqual([
    `http://agent-server.internal/agents/${OWN_AGENT}/workflows/abc/run`,
  ]);
  const headers = forwarded[0]?.headers;
  expect(headers?.get("cookie")).toBeNull();
  expect(headers?.get("authorization")).toBeNull();
  expect(headers?.get("x-api-key")).toBeNull();
  expect(headers?.get("x-eliza-agent-owner-id")).toBeNull();
  expect(headers?.get("x-eliza-user-id")).toBe(USER);
  expect(headers?.get("x-server-token")).toBe("server-secret");
});
