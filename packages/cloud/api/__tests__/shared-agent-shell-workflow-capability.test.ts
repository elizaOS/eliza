/**
 * Shared-agent REST compatibility coverage for the workflow URLs used by the
 * hosted app. The mounted Hono route is exercised at its real `/api/*` paths so
 * canonical workflow-proxy tests cannot hide a browser-path mismatch.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

import * as realResolveSharedAgent from "@/lib/services/shared-runtime/resolve-shared-agent";

const resolveSharedAgent = mock();

mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  ...realResolveSharedAgent,
  resolveSharedAgent,
}));

const shellRoute = (
  await import("../v1/eliza/agents/[agentId]/api/[...path]/route")
).default;

afterAll(() => {
  mock.module(
    "@/lib/services/shared-runtime/resolve-shared-agent",
    () => realResolveSharedAgent,
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

describe("shared-agent workflow capability on hosted app paths", () => {
  beforeEach(() => {
    resolveSharedAgent.mockReset();
    resolveSharedAgent.mockResolvedValue({
      agent: { execution_tier: "shared" },
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
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: "Not found",
      code: "resource_not_found",
    });
  });
});
