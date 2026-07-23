/**
 * Shared-agent REST compatibility coverage for the workflow URLs used by the
 * hosted app. The mounted Hono route is exercised at its real `/api/*` paths so
 * canonical workflow-proxy tests cannot hide a browser-path mismatch.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";
import * as realSharedRestAdapter from "@/lib/services/shared-runtime/shared-rest-adapter";

const resolveSharedAgent = mock();
const sharedRestCharacter = mock();

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolveSharedAgent,
  resolveSharedAgent,
}));
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  ...realSharedRestAdapter,
  sharedRestCharacter,
}));

const shellRoute = (
  await import("../v1/eliza/agents/[agentId]/api/[...path]/route")
).default;

afterAll(() => {
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolveSharedAgent,
  );
  mock.module(
    "@/lib/services/shared-runtime/shared-rest-adapter",
    () => realSharedRestAdapter,
  );
});

const AGENT_ID = "de42b5ff-72d3-4a1a-8a16-19aee293bfea";
const APP_ORIGIN = "https://localhost";
const app = new Hono();
app.route("/api/v1/eliza/agents/:agentId/api/:*{.+}", shellRoute);

function request(path: string, method = "GET") {
  return app.request(
    `https://api.elizacloud.ai/api/v1/eliza/agents/${AGENT_ID}/api/${path}`,
    { method, headers: { Origin: APP_ORIGIN } },
  );
}

function requestWithWorkerContext(path: string) {
  return app.request(
    `https://api.elizacloud.ai/api/v1/eliza/agents/${AGENT_ID}/api/${path}`,
    { headers: { Origin: APP_ORIGIN } },
    {
      SHARED_RUNTIME_CONVERSATIONS: {
        getByName: () => ({ fetch: async () => new Response() }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    },
  );
}

describe("shared-agent workflow capability on hosted app paths", () => {
  beforeEach(() => {
    resolveSharedAgent.mockReset();
    sharedRestCharacter.mockReset();
    resolveSharedAgent.mockResolvedValue({
      agent: {
        id: AGENT_ID,
        organization_id: "org-1",
        execution_tier: "shared",
      },
      agentId: AGENT_ID,
      orgId: "org-1",
      agentName: "Eliza",
    });
  });

  for (const [method, path] of [
    ["GET", "automations"],
    ["GET", "workflow/status"],
    ["POST", "workflow/workflows"],
    ["POST", "workflow/workflows/resolve-clarification"],
    ["GET", "workflow/workflows/workflow-1/evaluation-samples"],
    ["PUT", "workflow/workflows/workflow-1"],
    ["DELETE", "workflow/workflows/workflow-1"],
  ] as const) {
    test(`${method} /api/${path} returns the dedicated-runtime capability gate`, async () => {
      const response = await request(path, method);

      expect(response.status).toBe(409);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        APP_ORIGIN,
      );
      await expect(response.json()).resolves.toEqual({
        success: false,
        code: "workflow_requires_dedicated",
        error:
          "Workflows require a dedicated agent runtime. Upgrade this agent before managing workflows.",
        capability: "workflows",
        currentExecutionTier: "shared",
        requiredExecutionTier: "dedicated-always",
        upgradeRequired: true,
        upgrade: {
          automatic: false,
          method: "POST",
          endpoint: `/api/v1/eliza/agents/${AGENT_ID}/upgrade-tier`,
        },
      });
    });
  }

  test("an unrelated shared shell path remains a resource-not-found response", async () => {
    const response = await request("unknown-capability");

    expect(response.status).toBe(404);
    expect(resolveSharedAgent).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Not found",
      code: "resource_not_found",
    });
  });

  test("character fails closed before resolving identity without Worker runtime bindings", async () => {
    const response = await request("character");

    expect(response.status).toBe(503);
    expect(resolveSharedAgent).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      code: "shared_runtime_context_unavailable",
      retryable: true,
    });
  });

  test("character preserves a cold character cache as retryable 503", async () => {
    const warming = new Error("Character cache is warming. Retry shortly.");
    warming.name = "SharedRuntimeCacheWarmingError";
    sharedRestCharacter.mockRejectedValue(warming);

    const response = await requestWithWorkerContext("character");

    expect(response.status).toBe(503);
    expect(resolveSharedAgent.mock.calls[0]?.[1]).toMatchObject({
      cacheOnly: true,
      executionCtx: expect.objectContaining({
        waitUntil: expect.any(Function),
      }),
    });
    expect(sharedRestCharacter).toHaveBeenCalledTimes(1);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Character cache is warming. Retry shortly.",
      code: "shared_runtime_cache_warming",
      retryable: true,
    });
  });
});
