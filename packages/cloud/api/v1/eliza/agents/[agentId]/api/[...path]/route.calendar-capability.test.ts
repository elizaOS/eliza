/**
 * Verifies that Shared agents expose Calendar's unavailable execution tier as
 * one typed capability response for every supported method, while preserving
 * the catch-all route's complete CORS method contract.
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const AGENT = "dddddddd-5555-4555-8555-555555555555";
const CORS_ORIGIN = "https://staging.eliza.app";

function withCors(response: Response, methods: string, origin?: string) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Methods", methods);
  headers.set("Access-Control-Allow-Origin", origin ?? "*");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

mock.module("@/lib/mobile-push/types", () => ({
  MAX_MOBILE_PUSH_TOKEN_CHARACTERS: 4096,
}));
mock.module("@/lib/services/proxy/cors", () => ({
  applyCorsHeaders: withCors,
  handleCorsOptions: (methods: string, origin?: string) =>
    withCors(new Response(null, { status: 204 }), methods, origin),
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
      organization_id: "org-1",
      user_id: "user-1",
      agent_name: "Eliza",
      execution_tier: "shared",
    },
    agentId: AGENT,
    orgId: "org-1",
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

describe("Shared Calendar capability gate", () => {
  for (const [method, path] of [
    ["GET", "lifeops/calendar/feed"],
    ["POST", "lifeops/calendar/events"],
    ["PUT", "lifeops/calendar/events/event-1"],
    ["PATCH", "lifeops/calendar/events/event-1"],
    ["DELETE", "lifeops/calendar/events/event-1"],
  ] as const) {
    test(`returns the typed 503 for ${method}`, async () => {
      const response = await app.request(
        `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/${path}`,
        {
          method,
          headers: {
            "X-API-Key": "eliza_test",
            Origin: CORS_ORIGIN,
          },
        },
        ENV,
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
        CORS_ORIGIN,
      );
      expect((await response.json()) as Record<string, unknown>).toEqual({
        success: false,
        code: "calendar_runtime_unavailable",
        error:
          "Calendar requires a dedicated agent runtime; this shared agent does not run calendar connectors.",
        capability: "calendar",
        requiredExecutionTier: "dedicated-always",
        upgradeRequired: true,
        retryable: false,
      });
    });
  }

  test("advertises PATCH in the preflight method contract", async () => {
    const response = await app.request(
      `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/lifeops/calendar/feed`,
      { method: "OPTIONS", headers: { Origin: CORS_ORIGIN } },
      ENV,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      CORS_ORIGIN,
    );
  });
});
