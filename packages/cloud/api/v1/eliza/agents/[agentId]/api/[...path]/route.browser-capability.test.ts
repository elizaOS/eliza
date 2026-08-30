/**
 * Verifies Shared agents expose a typed Browser workspace capability boundary
 * through the real catch-all route. Dedicated requests are intercepted by the
 * owner-scoped proxy middleware before these handlers in production.
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const AGENT = "cccccccc-4444-4444-8444-444444444444";

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

const EXPECTED_UNAVAILABLE = {
  success: false,
  code: "browser_workspace_runtime_unavailable",
  error:
    "Browser workspace requires a dedicated agent runtime; this shared agent does not run an isolated browser workspace.",
  capability: "browser-workspace",
  requiredExecutionTier: "dedicated-always",
  upgradeRequired: true,
  retryable: false,
};

describe("Shared Browser workspace capability boundary", () => {
  for (const [method, path] of [
    ["GET", "browser-workspace"],
    ["POST", "browser-workspace/tabs"],
    ["PUT", "browser-workspace/tabs/tab-1"],
    ["PATCH", "browser-workspace/tabs/tab-1"],
    ["DELETE", "browser-workspace/tabs/tab-1"],
  ] as const) {
    test(`${method} ${path} returns typed non-retryable unavailability`, async () => {
      const response = await app.request(
        `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/${path}`,
        {
          method,
          headers: { "X-API-Key": "eliza_test" },
        },
        ENV,
      );

      expect(response.status).toBe(503);
      expect((await response.json()) as Record<string, unknown>).toEqual(
        EXPECTED_UNAVAILABLE,
      );
    });
  }
});
