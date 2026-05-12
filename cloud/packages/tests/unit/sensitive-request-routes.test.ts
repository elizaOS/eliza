import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const USER_ID = "22222222-2222-4222-8222-222222222222";
const ORG_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";

interface Harness {
  createCalls: unknown[];
  submitCalls: unknown[];
}

function requestView() {
  return {
    id: REQUEST_ID,
    kind: "secret",
    status: "pending",
    agentId: "agent-1",
    organizationId: ORG_ID,
    target: { kind: "secret", key: "OPENAI_API_KEY" },
    policy: { actor: "owner_or_linked_identity" },
    delivery: { mode: "cloud_authenticated_link" },
    expiresAt: new Date(Date.now() + 900_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function installMocks(harness: Harness): void {
  mock.module("@/lib/auth/workers-hono-auth", () => ({
    requireUserOrApiKeyWithOrg: async () => ({
      id: USER_ID,
      email: "owner@example.com",
      organization_id: ORG_ID,
      organization: { id: ORG_ID, is_active: true },
      is_active: true,
    }),
  }));

  mock.module("@/lib/middleware/rate-limit-hono-cloudflare", () => ({
    RateLimitPresets: { STANDARD: "standard", STRICT: "strict" },
    rateLimit: () => async (_c: unknown, next: () => Promise<void>) => next(),
  }));

  mock.module("@/lib/api/cloud-worker-errors", () => ({
    failureResponse: (_c: unknown, error: unknown) =>
      new Response(JSON.stringify({ success: false, error: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
  }));

  mock.module("@/lib/utils/logger", () => ({
    logger: { debug: () => {}, error: () => {}, info: () => {}, warn: () => {} },
  }));

  mock.module("@/lib/services/sensitive-requests", () => ({
    sensitiveRequestsService: {
      create: async (...args: unknown[]) => {
        harness.createCalls.push(args);
        return { request: requestView(), submitToken: "sr_test_token" };
      },
      get: async () => requestView(),
      submit: async (params: unknown) => {
        harness.submitCalls.push(params);
        return { ...requestView(), status: "fulfilled" };
      },
      cancel: async () => ({ ...requestView(), status: "canceled" }),
      expire: async () => ({ ...requestView(), status: "expired" }),
    },
  }));
}

async function loadCreateRoute() {
  const mod = await import(
    new URL(
      `../../../apps/api/v1/sensitive-requests/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const parent = new Hono();
  parent.route("/api/v1/sensitive-requests", mod.default as Hono);
  return parent;
}

async function loadSubmitRoute() {
  const mod = await import(
    new URL(
      `../../../apps/api/v1/sensitive-requests/[id]/submit/route.ts?test=${Date.now()}-${Math.random()}`,
      import.meta.url,
    ).href
  );
  const parent = new Hono();
  parent.route("/api/v1/sensitive-requests/:id/submit", mod.default as Hono);
  return parent;
}

describe("sensitive request routes", () => {
  beforeEach(() => mock.restore());
  afterEach(() => mock.restore());

  test("creates a cloud secret request without echoing a secret value", async () => {
    const harness: Harness = { createCalls: [], submitCalls: [] };
    installMocks(harness);
    const route = await loadCreateRoute();

    const response = await route.request("https://api.test/api/v1/sensitive-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "secret",
        agentId: "agent-1",
        target: { kind: "secret", key: "OPENAI_API_KEY" },
      }),
    });

    expect(response.status).toBe(201);
    const text = await response.text();
    expect(text).toContain("sr_test_token");
    expect(text).not.toContain("sk-test-canary");
    expect(harness.createCalls).toHaveLength(1);
  });

  test("submits a secret request without returning the submitted value", async () => {
    const harness: Harness = { createCalls: [], submitCalls: [] };
    installMocks(harness);
    const route = await loadSubmitRoute();

    const response = await route.request(
      `https://api.test/api/v1/sensitive-requests/${REQUEST_ID}/submit`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: "sr_test_token",
          value: "sk-test-canary",
        }),
      },
    );

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("sk-test-canary");
    expect(harness.submitCalls).toHaveLength(1);
  });
});
