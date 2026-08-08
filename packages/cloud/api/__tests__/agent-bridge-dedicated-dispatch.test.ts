/**
 * Pins that the agent bridge route serves BOTH tiers.
 *
 * The shared resolver refuses a dedicated agent by design; that refusal is a
 * routing signal, not a client verdict. #17076 collapsed the branch that read
 * it, so every dedicated agent 404'd for two weeks and iOS cloud chat broke in
 * production (#18062). These tests drive the real Hono route with a stubbed
 * resolver and sandbox service.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import * as realAuth from "@/lib/auth";
import * as realSandbox from "@/lib/services/eliza-sandbox";
import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";

const resolveSharedAgent = mock();
const sandboxBridge = mock();
const requireAuthOrApiKeyWithOrg = mock();

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolveSharedAgent,
  resolveSharedAgent,
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  ...realSandbox,
  elizaSandboxService: {
    ...realSandbox.elizaSandboxService,
    bridge: sandboxBridge,
  },
}));

mock.module("@/lib/auth", () => ({
  ...realAuth,
  requireAuthOrApiKeyWithOrg,
}));

const route = (await import("../v1/eliza/agents/[agentId]/bridge/route"))
  .default;

const RPC = {
  jsonrpc: "2.0",
  id: 1,
  method: "message.send",
  params: { text: "hi" },
};

function post() {
  // Hono's test helper takes (path, init, Env, executionCtx). The route refuses
  // with a 503 unless BOTH the Durable Object binding and a real waitUntil are
  // present, so the executionCtx must be the fourth argument, not an env key.
  return route.request(
    "/",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-API-Key": "eliza_test",
      },
      body: JSON.stringify(RPC),
    },
    { SHARED_RUNTIME_CONVERSATIONS: { getByName: () => ({}) } },
    {
      waitUntil: () => {},
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext,
  );
}

beforeEach(() => {
  resolveSharedAgent.mockReset();
  sandboxBridge.mockReset();
  requireAuthOrApiKeyWithOrg.mockReset();
  requireAuthOrApiKeyWithOrg.mockResolvedValue({
    user: { organization_id: "org-1" },
  });
});

describe("agent bridge dispatches both tiers", () => {
  test("a dedicated agent reaches its sandbox bridge instead of 404ing", async () => {
    // Exactly what resolveSharedAgent returns for a dedicated agent: a 404 that
    // carries the typed refusal. Before the fix this fell through to the generic
    // error branch and the caller got the routing discriminator as a verdict.
    resolveSharedAgent.mockResolvedValue({
      error: "Not a shared-runtime agent",
      status: 404,
      refusal: "dedicated-agent",
    });
    sandboxBridge.mockResolvedValue({
      jsonrpc: "2.0",
      id: 1,
      result: { ok: true },
    });

    const res = await post();

    expect(res.status).toBe(200);
    expect(sandboxBridge).toHaveBeenCalledTimes(1);
    // Org must come from the request's own credential: the shared resolver
    // refused, so it produced no authorized scope to inherit.
    const [, orgId] = sandboxBridge.mock.calls[0] as unknown[];
    expect(orgId).toBe("org-1");
    expect(await res.json()).toMatchObject({ result: { ok: true } });
  });

  test("a sleeping dedicated agent answers JSON-RPC, never 404", async () => {
    resolveSharedAgent.mockResolvedValue({
      error: "Not a shared-runtime agent",
      status: 404,
      refusal: "dedicated-agent",
    });
    // What eliza-sandbox returns when findRunningSandbox misses.
    sandboxBridge.mockResolvedValue({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32000, message: "Sandbox is not running" },
    });

    const res = await post();

    // A deactivated agent is a JSON-RPC-level condition the client can render;
    // a 404 would be indistinguishable from "this agent does not exist".
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      error: { code: -32000, message: "Sandbox is not running" },
    });
  });

  test("a genuine 404 without the refusal stays terminal", async () => {
    resolveSharedAgent.mockResolvedValue({
      error: "Agent not found",
      status: 404,
    });

    const res = await post();

    // The dispatch must key on the typed refusal, not on "any 404" — an agent
    // that truly does not exist must not be forwarded to the sandbox.
    expect(res.status).toBe(404);
    expect(sandboxBridge).not.toHaveBeenCalled();
  });

  test("a warming 503 is still retryable and never reaches the sandbox", async () => {
    resolveSharedAgent.mockResolvedValue({
      error: "Agent authorization cache is warming. Retry shortly.",
      status: 503,
    });

    const res = await post();

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("1");
    expect(await res.json()).toMatchObject({ retryable: true });
    expect(sandboxBridge).not.toHaveBeenCalled();
  });
});
