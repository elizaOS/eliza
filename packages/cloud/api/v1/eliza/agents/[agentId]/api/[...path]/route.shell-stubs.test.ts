/**
 * Contract tests for the Shared catch-all shell stubs added in this PR:
 * browser-workspace (designed-empty GET, fail-closed POST mutations) and
 * knowledge-view paths (memories, documents, relationships). Real route module
 * mounted on a real Hono router; the resolver and adapters are deterministic
 * fakes so no DB or auth service is required.
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const AGENT = "dddddddd-5555-5555-8555-555555555555";

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
  sharedRestGreeting: () => null,
  sharedRestOverlayPresence: () => ({}),
  sharedRestRuntimeMode: () => ({}),
  sharedRestStatus: () => ({}),
  sharedRestStreamSettings: () => ({}),
  sharedRestViewNavigate: () => null,
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

function url(path: string) {
  return `http://cloud.local/api/v1/eliza/agents/${AGENT}/api/${path}`;
}

// ─── browser-workspace ──────────────────────────────────────────────────────

describe("GET browser-workspace (designed-empty stub)", () => {
  test("returns 200 with empty workspace snapshot", async () => {
    const res = await app.request(
      url("browser-workspace"),
      { headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      mode: "web",
      tabs: [],
    });
  });
});

describe("POST browser-workspace mutations (fail-closed)", () => {
  test("POST browser-workspace/tabs returns 503 with typed code", async () => {
    const res = await app.request(
      url("browser-workspace/tabs"),
      { method: "POST", headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.success).toBe(false);
    expect(body.code).toBe("browser_workspace_unavailable");
  });

  test("POST browser-workspace/command returns 503", async () => {
    const res = await app.request(
      url("browser-workspace/command"),
      { method: "POST", headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(res.status).toBe(503);
  });

  test("POST browser-workspace/tabs/:id returns 503", async () => {
    const res = await app.request(
      url("browser-workspace/tabs/some-tab-id"),
      { method: "POST", headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(res.status).toBe(503);
  });
});

// ─── knowledge-view stubs ────────────────────────────────────────────────────

describe("GET memories/feed (designed-empty stub)", () => {
  test("returns 200 with empty feed shape", async () => {
    const res = await app.request(
      url("memories/feed"),
      { headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      memories: [],
      count: 0,
      limit: 50,
      hasMore: false,
    });
  });
});

describe("GET memories/stats (designed-empty stub)", () => {
  test("returns 200 with zero stats", async () => {
    const res = await app.request(
      url("memories/stats"),
      { headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      total: 0,
      byType: {},
    });
  });
});

describe("GET documents (designed-empty stub)", () => {
  test("returns 200 with empty documents list", async () => {
    const res = await app.request(
      url("documents"),
      { headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      documents: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
  });
});

describe("GET documents/facets (designed-empty stub)", () => {
  test("returns 200 with zero facet counts", async () => {
    const res = await app.request(
      url("documents/facets"),
      { headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      counts: {
        all: 0,
        doc: 0,
        image: 0,
        audio: 0,
        video: 0,
        transcript: 0,
      },
    });
  });
});

describe("GET relationships/people (designed-empty stub)", () => {
  test("returns 200 with empty people list and zero stats", async () => {
    const res = await app.request(
      url("relationships/people"),
      { headers: { "X-API-Key": "eliza_test" } },
      ENV,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({
      data: [],
      stats: { totalPeople: 0, totalRelationships: 0, totalIdentities: 0 },
    });
  });
});

describe("POST views/{viewId}/elements (best-effort ack)", () => {
  test("POST views/memories/elements returns 200 ok", async () => {
    const res = await app.request(
      url("views/memories/elements"),
      {
        method: "POST",
        headers: {
          "X-API-Key": "eliza_test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ elements: [], viewPath: "/memories" }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true });
  });

  test("POST views/documents/elements returns 200 ok", async () => {
    const res = await app.request(
      url("views/documents/elements"),
      {
        method: "POST",
        headers: {
          "X-API-Key": "eliza_test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ elements: [], viewPath: "/documents" }),
      },
      ENV,
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as Record<string, unknown>).toEqual({ ok: true });
  });
});
