/** Tests authenticated, recipient-scoped in-app lifecycle leasing and acknowledgement. */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const INTERNAL_NOTICE = {
  sessionId: `lifecycle:${"a".repeat(48)}`,
  leaseId: "lease-1",
  platformUserId: USER_ID,
  deliveryNonce: "internal-nonce",
  message: "Your workspace is ready. I can continue when you're back.",
  createdAt: "2026-08-19T12:00:00.000Z",
  expiresAt: "2026-08-26T12:00:00.000Z",
  lifecycleEvents: [
    {
      kind: "workspace_ready",
      idempotencyKey: "workspace-ready:source-1",
      userId: USER_ID,
      organizationId: "org-1",
      resourceId: "workspace-1",
      origin: "web",
      preferredChannel: "in_app",
    },
  ],
};
const drain = mock(async (): Promise<unknown[]> => [INTERNAL_NOTICE]);
const acknowledge = mock(async () => 1);
const requireAuth = mock(async (request: Request) => {
  if (!request.headers.get("authorization")) throw new Error("Unauthorized");
  return { user: { id: USER_ID, organization_id: "org-1" } };
});

mock.module("@/lib/services/eliza-app/onboarding-proactive-greeting", () => ({
  drainProactiveGreetings: drain,
  acknowledgeProactiveGreetings: acknowledge,
  enqueueProactiveLifecycleMessage: mock(async () => undefined),
}));
mock.module("@/lib/auth", () => ({ requireAuthOrApiKeyWithOrg: requireAuth }));

const app = (await import("./route")).default;

beforeEach(() => {
  drain.mockClear();
  drain.mockImplementation(async () => [INTERNAL_NOTICE]);
  acknowledge.mockClear();
  requireAuth.mockClear();
});

function request(body: unknown, authorized = true): Request {
  return new Request("https://cloud.test/", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: "Bearer test" } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("in-app lifecycle follow-up route", () => {
  test("scopes every claim to the authenticated user", async () => {
    const response = await app.request(request({ action: "claim" }));
    expect(response.status).toBe(200);
    expect(drain).toHaveBeenCalledWith("in_app", { platformUserId: USER_ID });
  });

  test("projects a strict public DTO without identity or routing metadata", async () => {
    const response = await app.request(request({ action: "claim" }));
    const body = (await response.json()) as { notices: unknown[] };

    expect(body.notices).toEqual([
      {
        sessionId: INTERNAL_NOTICE.sessionId,
        leaseId: "lease-1",
        message: INTERNAL_NOTICE.message,
        createdAt: INTERNAL_NOTICE.createdAt,
        expiresAt: INTERNAL_NOTICE.expiresAt,
        lifecycleEvents: [
          {
            kind: "workspace_ready",
            idempotencyKey: "workspace-ready:source-1",
            resourceId: "workspace-1",
          },
        ],
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(USER_ID);
    expect(JSON.stringify(body)).not.toContain("organizationId");
    expect(JSON.stringify(body)).not.toContain("preferredChannel");
  });

  test("drops a notice with malformed nested lifecycle metadata", async () => {
    drain.mockImplementation(async () => [
      {
        ...INTERNAL_NOTICE,
        lifecycleEvents: [
          {
            ...INTERNAL_NOTICE.lifecycleEvents[0],
            kind: "internal_admin_event",
          },
        ],
      },
    ]);

    const response = await app.request(request({ action: "claim" }));
    expect((await response.json()) as unknown).toEqual({ notices: [] });
  });

  test("preserves a target-bound 4000-character continuation", async () => {
    const agentId = "22222222-2222-4222-8222-222222222222";
    const originalIntent = "x".repeat(4000);
    drain.mockImplementation(async () => [
      {
        ...INTERNAL_NOTICE,
        lifecycleEvents: [
          {
            ...INTERNAL_NOTICE.lifecycleEvents[0],
            agentId,
            continuation: {
              originalIntent,
              capabilityId: "calendar",
              requiresConfirmation: true,
            },
          },
        ],
      },
    ]);

    const response = await app.request(request({ action: "claim" }));
    const body = (await response.json()) as {
      notices: Array<{ lifecycleEvents: unknown[] }>;
    };
    expect(body.notices[0]?.lifecycleEvents).toEqual([
      {
        kind: "workspace_ready",
        idempotencyKey: "workspace-ready:source-1",
        resourceId: "workspace-1",
        agentId,
        continuation: {
          originalIntent,
          capabilityId: "calendar",
          requiresConfirmation: true,
        },
      },
    ]);
  });

  test("rejects an over-limit continuation instead of returning it", async () => {
    drain.mockImplementation(async () => [
      {
        ...INTERNAL_NOTICE,
        lifecycleEvents: [
          {
            ...INTERNAL_NOTICE.lifecycleEvents[0],
            agentId: "22222222-2222-4222-8222-222222222222",
            continuation: {
              originalIntent: "x".repeat(4001),
              capabilityId: "calendar",
              requiresConfirmation: true,
            },
          },
        ],
      },
    ]);

    const response = await app.request(request({ action: "claim" }));
    expect((await response.json()) as unknown).toEqual({ notices: [] });
  });

  test("binds acknowledgements to the same authenticated recipient", async () => {
    const acknowledgements = [
      { sessionId: `lifecycle:${"a".repeat(48)}`, leaseId: "lease-1" },
    ];
    const response = await app.request(
      request({ action: "ack", acknowledgements }),
    );
    expect(response.status).toBe(200);
    expect(acknowledge).toHaveBeenCalledWith("in_app", acknowledgements, {
      platformUserId: USER_ID,
    });
  });

  test("rejects malformed replay acknowledgements before queue access", async () => {
    const response = await app.request(
      request({
        action: "ack",
        acknowledgements: [{ sessionId: "another-user", leaseId: "lease-1" }],
      }),
    );
    expect(response.status).toBe(400);
    expect(acknowledge).not.toHaveBeenCalled();
  });

  test("does not allow an unauthenticated claim", async () => {
    const response = await app.request(request({ action: "claim" }, false));
    expect(response.status).toBe(500);
    expect(drain).not.toHaveBeenCalled();
  });
});
