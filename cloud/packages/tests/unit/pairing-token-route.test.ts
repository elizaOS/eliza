/**
 * Unit tests for POST /api/v1/eliza/agents/[agentId]/pairing-token
 *
 * Exercises the state-machine branches added when we replaced the
 * "Agent must be running" 400 with auto-resume + 202.
 *
 *   running        → 200 with token
 *   pending        → 202, enqueueAgentProvisionOnce called
 *   stopped        → 202, enqueueAgentProvisionOnce called
 *   disconnected   → 202, enqueueAgentProvisionOnce called
 *   provisioning   → 202, enqueue NOT called (already in flight)
 *   error          → 500
 *
 * Mocks every external dependency via `mock.module()` so this can run
 * without DB / Redis / Stripe / session auth.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_USER = { id: "u1", organization_id: "o1" };
const TEST_AGENT_ID = "11111111-1111-4111-8111-111111111111";

interface MockSandbox {
  id: string;
  agent_name: string | null;
  status: "pending" | "provisioning" | "running" | "stopped" | "disconnected" | "error";
  bridge_url: string | null;
  health_url: string | null;
  environment_vars: Record<string, string> | null;
  updated_at: Date;
}

function makeSandbox(overrides: Partial<MockSandbox> = {}): MockSandbox {
  return {
    id: TEST_AGENT_ID,
    agent_name: "test-agent",
    status: "running",
    bridge_url: "https://bridge.example.com",
    health_url: "https://health.example.com",
    environment_vars: { ELIZA_API_TOKEN: "tok" },
    updated_at: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

interface MockedSandboxState {
  sandbox: MockSandbox | null;
  enqueueCalled: number;
  generateTokenCalled: number;
  enqueueError?: Error;
}

function buildMocks(state: MockedSandboxState) {
  mock.module("@/lib/auth", () => ({
    requireAuthOrApiKeyWithOrg: async () => ({ user: TEST_USER }),
  }));
  mock.module("@/db/repositories/agent-sandboxes", () => ({
    agentSandboxesRepository: {
      findByIdAndOrg: async () => state.sandbox,
    },
  }));
  mock.module("@/lib/eliza-agent-web-ui", () => ({
    getElizaAgentPublicWebUiUrl: () => "https://ui.example.com",
  }));
  mock.module("@/lib/services/pairing-token", () => ({
    getPairingTokenService: () => ({
      generateToken: async () => {
        state.generateTokenCalled += 1;
        return "test-pairing-token";
      },
    }),
  }));
  mock.module("@/lib/services/provisioning-jobs", () => ({
    provisioningJobService: {
      enqueueAgentProvisionOnce: async () => {
        state.enqueueCalled += 1;
        if (state.enqueueError) {
          throw state.enqueueError;
        }
        return { job: { id: "job-1", status: "pending" }, created: true };
      },
    },
  }));
  mock.module("@/lib/services/proxy/cors", () => ({
    applyCorsHeaders: (response: Response) => response,
    handleCorsOptions: () => new Response(null, { status: 204 }),
  }));
  mock.module("@/lib/api/errors", () => ({
    errorToResponse: (error: unknown) =>
      Response.json(
        { success: false, error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      ),
  }));
  mock.module("@/lib/utils/logger", () => ({
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  }));
}

// Both the live Next.js handler (cloud/app/api/...) and the Worker migration
// target (cloud/apps/api/...) MUST share behavior — when one drifts the
// `cloud open` flow breaks. We import both and run the full state-machine
// suite against each.
const ROUTE_PATHS = {
  "app/api (live Next.js)": "../../../apps/api/v1/eliza/agents/[agentId]/pairing-token/route.ts",
  "apps/api (Worker target)": "../../../apps/api/v1/eliza/agents/[agentId]/pairing-token/route.ts",
} as const;

async function importRoute(relativePath: string) {
  const url = new URL(`${relativePath}?test=${Date.now()}-${Math.random()}`, import.meta.url);
  return import(url.href) as Promise<{
    POST: (request: Request, ctx: { params: Promise<{ agentId: string }> }) => Promise<Response>;
  }>;
}

function buildRequest(): Request {
  return new Request(`https://elizacloud.ai/api/v1/eliza/agents/${TEST_AGENT_ID}/pairing-token`, {
    method: "POST",
    headers: {
      Authorization: "Bearer eliza_test_key",
      "X-Api-Key": "eliza_test_key",
    },
  });
}

const params = { params: Promise.resolve({ agentId: TEST_AGENT_ID }) };
const originalNodeEnv = process.env.NODE_ENV;
const originalRequireProvisioningWorker = process.env.REQUIRE_PROVISIONING_WORKER;

function restoreOptionalEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

describe.each(Object.entries(ROUTE_PATHS))("pairing-token route — %s", (_label, routePath) => {
  beforeEach(() => {
    mock.restore();
    process.env.NODE_ENV = "test";
    restoreOptionalEnv("REQUIRE_PROVISIONING_WORKER", originalRequireProvisioningWorker);
  });
  afterEach(() => {
    mock.restore();
    restoreOptionalEnv("NODE_ENV", originalNodeEnv);
    restoreOptionalEnv("REQUIRE_PROVISIONING_WORKER", originalRequireProvisioningWorker);
  });

  test("status=running issues a token (200)", async () => {
    const state: MockedSandboxState = {
      sandbox: makeSandbox({ status: "running" }),
      enqueueCalled: 0,
      generateTokenCalled: 0,
    };
    buildMocks(state);

    const { POST } = await importRoute(routePath);
    const res = await POST(buildRequest(), params);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      success: boolean;
      data: { token: string; redirectUrl: string; expiresIn: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.token).toBe("test-pairing-token");
    expect(body.data.expiresIn).toBe(60);
    expect(state.enqueueCalled).toBe(0);
    expect(state.generateTokenCalled).toBe(1);
  });

  test("status=stopped enqueues resume and returns 202 with Retry-After", async () => {
    const state: MockedSandboxState = {
      sandbox: makeSandbox({ status: "stopped" }),
      enqueueCalled: 0,
      generateTokenCalled: 0,
    };
    buildMocks(state);

    const { POST } = await importRoute(routePath);
    const res = await POST(buildRequest(), params);

    expect(res.status).toBe(202);
    expect(res.headers.get("Retry-After")).toBe("5");
    const body = (await res.json()) as {
      success: boolean;
      data: { status: string; jobId?: string; retryAfterMs: number };
    };
    expect(body.success).toBe(true);
    expect(body.data.status).toBe("starting");
    expect(body.data.jobId).toBe("job-1");
    expect(body.data.retryAfterMs).toBe(5000);
    expect(state.enqueueCalled).toBe(1);
    expect(state.generateTokenCalled).toBe(0);
  });

  test("status=pending enqueues resume and returns 202", async () => {
    const state: MockedSandboxState = {
      sandbox: makeSandbox({ status: "pending" }),
      enqueueCalled: 0,
      generateTokenCalled: 0,
    };
    buildMocks(state);

    const { POST } = await importRoute(routePath);
    const res = await POST(buildRequest(), params);

    expect(res.status).toBe(202);
    expect(state.enqueueCalled).toBe(1);
  });

  test("status=disconnected enqueues resume and returns 202", async () => {
    const state: MockedSandboxState = {
      sandbox: makeSandbox({ status: "disconnected" }),
      enqueueCalled: 0,
      generateTokenCalled: 0,
    };
    buildMocks(state);

    const { POST } = await importRoute(routePath);
    const res = await POST(buildRequest(), params);

    expect(res.status).toBe(202);
    expect(state.enqueueCalled).toBe(1);
  });

  test("status=provisioning returns 202 WITHOUT re-enqueueing", async () => {
    const state: MockedSandboxState = {
      sandbox: makeSandbox({ status: "provisioning" }),
      enqueueCalled: 0,
      generateTokenCalled: 0,
    };
    buildMocks(state);

    const { POST } = await importRoute(routePath);
    const res = await POST(buildRequest(), params);

    expect(res.status).toBe(202);
    expect(state.enqueueCalled).toBe(0);
    const body = (await res.json()) as { data: { status: string } };
    expect(body.data.status).toBe("starting");
  });

  test("status=error returns 500 instead of looping", async () => {
    const state: MockedSandboxState = {
      sandbox: makeSandbox({ status: "error" }),
      enqueueCalled: 0,
      generateTokenCalled: 0,
    };
    buildMocks(state);

    const { POST } = await importRoute(routePath);
    const res = await POST(buildRequest(), params);

    expect(res.status).toBe(500);
    expect(state.enqueueCalled).toBe(0);
    const body = (await res.json()) as { success: boolean; data?: { status: string } };
    expect(body.success).toBe(false);
    expect(body.data?.status).toBe("error");
  });

  test("missing sandbox returns 404", async () => {
    const state: MockedSandboxState = {
      sandbox: null,
      enqueueCalled: 0,
      generateTokenCalled: 0,
    };
    buildMocks(state);

    const { POST } = await importRoute(routePath);
    const res = await POST(buildRequest(), params);

    expect(res.status).toBe(404);
    expect(state.enqueueCalled).toBe(0);
  });

  test("enqueue failure on resumable status fails instead of telling clients to poll forever", async () => {
    const state: MockedSandboxState = {
      sandbox: makeSandbox({ status: "stopped" }),
      enqueueCalled: 0,
      generateTokenCalled: 0,
      enqueueError: new Error("transient enqueue failure"),
    };
    buildMocks(state);

    const { POST } = await importRoute(routePath);
    const res = await POST(buildRequest(), params);

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      success: boolean;
      code: string;
      error: string;
      retryable: boolean;
    };
    expect(body).toEqual({
      success: false,
      code: "PROVISIONING_ENQUEUE_FAILED",
      error: "Failed to start agent resume. Retry in a moment.",
      retryable: true,
    });
  });
});
