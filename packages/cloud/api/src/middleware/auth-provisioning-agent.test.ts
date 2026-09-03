/**
 * Verifies that eliza-app provisioning agent routes bypass the global Steward
 * session gate so requests bearing eliza-app session tokens reach the route-level
 * handlers, and verifies that real route handlers enforce session validation
 * (rejecting missing or invalid Bearer tokens).
 */

import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

mock.module("@elizaos/plugin-sql", () => ({}));

// Mock Steward auth to return null (no Steward session)
mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: mock(async () => null),
  getRequestIp: mock(() => "127.0.0.1"),
}));

import * as errorsActual from "@/lib/api/cloud-worker-errors";

mock.module("@/lib/api/cloud-worker-errors", () => ({
  ...errorsActual,
  jsonError: mock((c: { json: (body: unknown, status: number) => Response }) =>
    c.json({ error: "Unauthorized", code: "authentication_required" }, 401),
  ),
  failureResponse: mock(
    (c: { json: (body: unknown, status: number) => Response }, err: unknown) =>
      c.json({ error: "Internal error", details: String(err) }, 500),
  ),
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    error: mock(),
    warn: mock(),
    info: mock(),
  },
}));

mock.module("../services/audit-dispatcher-singleton", () => ({
  getAuditDispatcher: () => ({
    emit: mock(async () => undefined),
  }),
}));

mock.module("../../v1/remote/host-auth", () => ({
  parseRemoteHostCredential: mock(() => null),
}));

// Mock containersEnv and services required by provisioning-agent route
mock.module("@/lib/config/containers-env", () => ({
  containersEnv: {
    defaultAgentImage: () => "ghcr.io/elizaos/eliza:stable",
    sshUser: () => "root",
  },
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    createAgent: mock(async () => ({
      agent: { id: "test", status: "running" },
    })),
    deleteAgent: mock(async () => undefined),
  },
}));

mock.module("@/lib/services/provisioning-jobs", () => ({
  provisioningJobService: {
    enqueueAgentProvision: mock(async () => undefined),
  },
}));

const mockValidateAuthHeader = mock(async (header: string) => {
  if (header === "Bearer valid-session-token") {
    return { userId: "user-test-1", organizationId: "org-test-1" };
  }
  return null;
});

mock.module("@/lib/services/eliza-app", () => ({
  elizaAppSessionService: {
    validateAuthHeader: mockValidateAuthHeader,
  },
}));

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    listByOrganization: mock(async () => [
      {
        id: "sandbox-1",
        status: "running",
        bridge_url: "https://bridge.example.com",
        user_id: "user-test-1",
        organization_id: "org-test-1",
        execution_tier: "isolated",
        pool_status: null,
        deleted_at: null,
        deletion_attempt_id: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
      },
    ]),
  },
  prepareAgentBackupInsertData: mock(() => ({})),
}));

mock.module("@/lib/services/agent-billing-gate", () => ({
  checkAgentCreditGate: mock(async () => ({ allowed: true, balance: 100 })),
}));

// Mock generative route auth so chat does not perform real database user queries
mock.module("@/api-app/lib/generative-route-auth", () => ({
  requireGenerativeKnownIdentity: mock(async () => ({
    userId: "user-test-1",
    organizationId: "org-test-1",
    user: { id: "user-test-1" },
  })),
  getGenerativeOperationContext: mock(() => ({})),
}));

mock.module("@/lib/services/provisioning-agent-chat", () => ({
  provisioningAgentChat: mock(async () => ({
    reply: "Hello from provisioning agent",
    containerStatus: "running",
    agentId: "sandbox-1",
    bridgeUrl: "https://bridge.example.com",
  })),
}));

const { isPublicPath, authMiddleware } = await import("./auth");
const { default: provisioningAgentRoute } = await import(
  "../../eliza-app/provisioning-agent/route"
);
const { default: provisioningAgentChatRoute } = await import(
  "../../eliza-app/provisioning-agent/chat/route"
);

const testEnv = { NODE_ENV: "test" };

describe("isPublicPath provisioning-agent exact match bypass", () => {
  test.each([
    "/api/eliza-app/provisioning-agent",
    "/api/eliza-app/provisioning-agent/",
    "/api/eliza-app/provisioning-agent/chat",
    "/api/eliza-app/provisioning-agent/chat/",
  ])("bypasses global session gate for %s", (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  test.each([
    "/api/eliza-app/provisioning-agent-unknown",
    "/api/eliza-app/provisioning-agent/extra/nested",
    "/api/eliza-app/provisioning",
    "/api/admin/provisioning-agent",
  ])("does not bypass global session gate for unrelated %s", (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe("authMiddleware with real provisioning-agent route validation", () => {
  function createTestApp() {
    const app = new Hono();
    app.use("*", authMiddleware);
    app.route("/api/eliza-app/provisioning-agent", provisioningAgentRoute);
    app.route(
      "/api/eliza-app/provisioning-agent/chat",
      provisioningAgentChatRoute,
    );
    app.get("/api/admin/metrics", (c) => c.text("secret"));
    return app;
  }

  test("GET /api/eliza-app/provisioning-agent with valid Bearer token returns sandbox status", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/eliza-app/provisioning-agent",
      {
        headers: { Authorization: "Bearer valid-session-token" },
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: {
        status: "running",
        agentId: "sandbox-1",
        bridgeUrl: "https://bridge.example.com",
      },
    });
  });

  test("GET /api/eliza-app/provisioning-agent with missing Authorization is rejected by route handler with 401 UNAUTHORIZED", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/eliza-app/provisioning-agent",
      {},
      testEnv,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      error: "Authorization required",
      code: "UNAUTHORIZED",
    });
  });

  test("GET /api/eliza-app/provisioning-agent with invalid Bearer garbage is rejected by route handler with 401 UNAUTHORIZED", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/eliza-app/provisioning-agent",
      {
        headers: { Authorization: "Bearer garbage" },
      },
      testEnv,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      error: "Authorization required",
      code: "UNAUTHORIZED",
    });
  });

  test("POST /api/eliza-app/provisioning-agent/chat with invalid Bearer garbage is rejected by route handler with 401 INVALID_SESSION", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/eliza-app/provisioning-agent/chat",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer garbage",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "Hello" }),
      },
      testEnv,
    );

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({
      error: "Invalid or expired session",
      code: "INVALID_SESSION",
    });
  });

  test("POST /api/eliza-app/provisioning-agent/chat with valid Bearer token executes chat handler", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/eliza-app/provisioning-agent/chat",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer valid-session-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "Hello agent" }),
      },
      testEnv,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      success: true,
      data: {
        reply: "Hello from provisioning agent",
        containerStatus: "running",
        agentId: "sandbox-1",
        bridgeUrl: "https://bridge.example.com",
      },
    });
  });

  test("rejects request to non-public protected route without Steward session with 401 authentication_required", async () => {
    const app = createTestApp();
    const res = await app.request("/api/admin/metrics", {}, testEnv);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Unauthorized",
      code: "authentication_required",
    });
  });
});
