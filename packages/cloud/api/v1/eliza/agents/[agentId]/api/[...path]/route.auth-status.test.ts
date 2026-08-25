/**
 * Verifies the Shared catch-all answers the legacy `auth/status` startup probe
 * with the adapter's authenticated-bearer projection for a resolved Shared
 * agent, and still 404s an unknown shell path. Real route module mounted on a
 * real Hono router; the resolver, adapter, and CORS helpers are deterministic
 * fakes.
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const AGENT = "cccccccc-4444-4444-8444-444444444444";
const authStatusCalls: number[] = [];

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
  sharedRestAuthStatus: () => {
    authStatusCalls.push(Date.now());
    return {
      required: false,
      authenticated: true,
      pairingEnabled: false,
      expiresAt: null,
      localAccess: false,
      passwordConfigured: false,
    };
  },
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

describe("GET .../api/auth/status (Shared shell probe)", () => {
  test("returns the authenticated-bearer projection", async () => {
    const response = await app.request(
      `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/auth/status`,
      { headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(response.status).toBe(200);
    expect((await response.json()) as Record<string, unknown>).toEqual({
      required: false,
      authenticated: true,
      pairingEnabled: false,
      expiresAt: null,
      localAccess: false,
      passwordConfigured: false,
    });
    expect(authStatusCalls).toHaveLength(1);
  });

  test("keeps unknown shell paths at 404", async () => {
    const response = await app.request(
      `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/auth/unknown`,
      { headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(response.status).toBe(404);
    expect(authStatusCalls).toHaveLength(1);
  });
});
