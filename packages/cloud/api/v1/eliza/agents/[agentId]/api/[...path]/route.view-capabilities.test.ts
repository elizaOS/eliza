/** Shared Knowledge capability and durable Memories route coverage. */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const AGENT = "cccccccc-4444-4444-8444-444444444444";
const ORGANIZATION = "aaaaaaaa-1111-4111-8111-111111111111";
const USER = "bbbbbbbb-2222-4222-8222-222222222222";
const memoryCalls: unknown[] = [];

mock.module("@/lib/mobile-push/types", () => ({
  MAX_MOBILE_PUSH_TOKEN_CHARACTERS: 4096,
}));
mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: (response: Response) => response,
  handleCorsOptions: () => new Response(null, { status: 204 }),
}));
mock.module("@/lib/services/shared-runtime/conversation-coordinator", () => ({
  coordinateSharedPushList: async () => [],
  coordinateSharedPushRegister: async () => ({}),
  coordinateSharedPushUnregister: async () => ({}),
}));
mock.module("@/lib/services/shared-runtime/resolve-shared-agent", () => ({
  resolveSharedAgent: async () => ({
    agent: {
      id: AGENT,
      organization_id: ORGANIZATION,
      user_id: USER,
      agent_name: "Eliza",
      execution_tier: "shared",
    },
    agentId: AGENT,
    orgId: ORGANIZATION,
    agentName: "Eliza",
    agentKind: "sandbox",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
  }),
  resolveSharedRuntimeWorkerRequestContext: () => ({
    error: "unavailable",
    status: 503,
  }),
}));
mock.module("@/lib/services/shared-runtime/shared-rest-adapter", () => ({
  sharedRestAgentEvents: () => ({}),
  sharedRestAgentStart: () => ({}),
  sharedRestAuthMe: () => ({}),
  sharedRestAuthStatus: () => ({}),
  sharedRestCharacter: () => ({}),
  sharedRestCommands: () => ({}),
  sharedRestConfig: () => ({}),
  sharedRestCustomActions: () => ({}),
  sharedRestFirstRun: () => ({}),
  sharedRestFirstRunStatus: () => ({}),
  sharedRestFirstRunSubmit: () => ({}),
  sharedRestGreeting: () => ({}),
  sharedRestOverlayPresence: () => ({}),
  sharedRestRuntimeMode: () => ({}),
  sharedRestStatus: () => ({}),
  sharedRestStreamSettings: () => ({}),
  sharedRestViewNavigate: () => ({}),
  sharedRestViews: () => ({}),
}));
mock.module("@/lib/services/shared-runtime/shared-memory-rest-adapter", () => ({
  sharedMemoryRestRequest: async (request: unknown) => {
    memoryCalls.push(request);
    return {
      status: 200,
      data: { memories: [], count: 0, limit: 10, hasMore: false },
    };
  },
}));
mock.module("../../workflows/_shared", () => ({
  workflowRuntimeUnavailableResponse: () =>
    Response.json({ success: false }, { status: 409 }),
}));

const { default: route } = await import("./route");
const app = new Hono<AppEnv>();
app.route("/api/v1/eliza/agents/:agentId/api/:*{.+}", route);
const ENV = {
  ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
} as unknown as AppEnv["Bindings"];

describe("Shared view capability routes", () => {
  test("serves Memories from the tenant-scoped Shared adapter", async () => {
    const response = await app.request(
      `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/memories/feed?limit=10`,
      { headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      memories: [],
      count: 0,
      limit: 10,
      hasMore: false,
    });
    expect(memoryCalls).toEqual([
      {
        path: "memories/feed",
        searchParams: new URLSearchParams("limit=10"),
        identity: {
          organizationId: ORGANIZATION,
          userId: USER,
          sourceAgentId: AGENT,
        },
      },
    ]);
  });

  test("classifies people filters as a non-retryable Shared capability boundary", async () => {
    const response = await app.request(
      `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/relationships/people?limit=200`,
      { headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({
      success: false,
      code: "relationships_runtime_unavailable",
      error:
        "People filters require a dedicated agent runtime; this shared agent does not host the relationships graph.",
      capability: "relationships",
      requiredExecutionTier: "dedicated-always",
      upgradeRequired: true,
      retryable: false,
    });
  });

  for (const method of ["GET", "POST", "PATCH", "DELETE"] as const) {
    test(`${method} documents exposes the Dedicated capability boundary`, async () => {
      const response = await app.request(
        `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/documents`,
        {
          method,
          headers: { "X-API-Key": "eliza_test" },
        },
        ENV,
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({
        success: false,
        code: "documents_runtime_unavailable",
        error:
          "Knowledge documents require a dedicated agent runtime; this shared agent does not have a document ingest store.",
        capability: "knowledge-documents",
        requiredExecutionTier: "dedicated-always",
        upgradeRequired: true,
        retryable: false,
      });
    });
  }

  for (const [method, path] of [
    ["GET", "trajectories?limit=50"],
    ["POST", "trajectories/export"],
    ["PUT", "trajectories/config"],
    ["PATCH", "trajectories/config"],
    ["DELETE", "trajectories"],
  ] as const) {
    test(`${method} ${path} exposes the Dedicated trajectories boundary`, async () => {
      const response = await app.request(
        `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/${path}`,
        {
          method,
          headers: { "X-API-Key": "eliza_test" },
        },
        ENV,
      );
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({
        success: false,
        code: "trajectories_runtime_unavailable",
        error:
          "Trajectory history requires a dedicated agent runtime; this shared agent does not record or manage trajectories.",
        capability: "trajectories",
        requiredExecutionTier: "dedicated-always",
        upgradeRequired: true,
        retryable: false,
      });
    });
  }
});
