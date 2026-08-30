/**
 * Verifies Shared agents expose the Notes execution-tier boundary through the
 * real catch-all Hono route instead of returning an ambiguous missing path.
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

async function expectNotesUnavailable(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect((await response.json()) as Record<string, unknown>).toEqual({
    success: false,
    code: "notes_runtime_unavailable",
    error:
      "Notes require a dedicated agent runtime; this shared agent does not have a persistent notes store.",
    capability: "notes",
    requiredExecutionTier: "dedicated-always",
    upgradeRequired: true,
    retryable: false,
  });
}

describe("Shared Notes capability boundary", () => {
  test("answers the Notes state request with typed unavailability", async () => {
    await expectNotesUnavailable(
      await app.request(
        `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/notes/state`,
        { headers: { "X-API-Key": "eliza_test" } },
        ENV,
      ),
    );
  });

  test("answers the Notes interaction request with typed unavailability", async () => {
    await expectNotesUnavailable(
      await app.request(
        `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/views/notes/interact`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-Key": "eliza_test",
          },
          body: JSON.stringify({ capability: "get-notes" }),
        },
        ENV,
      ),
    );
  });
});
