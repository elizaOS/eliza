/**
 * Web Push subscription store routes. Validates that a well-formed
 * PushSubscription upserts keyed to the authed user, a bad body 400s, and a
 * DELETE removes by endpoint scoped to that user.
 */

import { describe, expect, mock, test } from "bun:test";

const requireUserMock = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));
// Typed params so `.mock.calls[0][0]` is well-typed (a bare `mock(async () =>
// …)` infers an empty-args tuple, which fails tuple-index typechecking).
const upsertMock = mock(async (_input: Record<string, unknown>) => ({
  id: "sub-1",
}));
const deleteByEndpointMock = mock(
  async (_userId: string, _endpoint: string) => 1,
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: requireUserMock,
}));

mock.module("@/db/repositories/web-push-subscriptions", () => ({
  webPushSubscriptionsRepository: {
    upsert: upsertMock,
    deleteByEndpoint: deleteByEndpointMock,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: {
    info: mock(() => undefined),
    warn: mock(() => undefined),
    debug: mock(() => undefined),
  },
}));

// Mock the remaining aliased route deps so the route module imports cleanly
// under the isolated cloud-api unit runner (which resolves `@/…` but only if
// every alias the route pulls in is provided). `failureResponse` just needs to
// return a 500-ish response; `isValidPushEndpoint` keeps its real logic so the
// SSRF-guard assertions below exercise the actual validation.
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: { json: (b: unknown, s: number) => unknown }) =>
    c.json({ error: "internal error" }, 500),
}));

mock.module("@/lib/web-push", () => ({
  isValidPushEndpoint: (value: string): boolean => {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") return false;
      const host = url.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "0.0.0.0" ||
        host === "::1" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".internal") ||
        host.startsWith("[")
      ) {
        return false;
      }
      const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (ipv4) {
        const a = Number(ipv4[1]);
        const b = Number(ipv4[2]);
        if (
          a === 0 ||
          a === 10 ||
          a === 127 ||
          (a === 192 && b === 168) ||
          (a === 172 && b >= 16 && b <= 31) ||
          (a === 169 && b === 254) ||
          a >= 224
        ) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  },
  notifyAgentReply: mock(async () => ({
    pushed: false,
    reason: "unconfigured",
  })),
}));

const { default: app } = await import("./route");

const VALID_AGENT = "00000000-0000-4000-8000-000000000001";

describe("POST /api/v1/web-push/subscriptions", () => {
  test("stores a well-formed subscription keyed to the authed user", async () => {
    upsertMock.mockClear();
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: VALID_AGENT,
        subscription: {
          endpoint: "https://push.example.com/abc",
          keys: { p256dh: "PUB", auth: "AUTH" },
        },
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ id: "sub-1", ok: true });
    expect(upsertMock).toHaveBeenCalledTimes(1);
    const arg = upsertMock.mock.calls[0][0];
    expect(arg).toEqual({
      userId: "user-1",
      agentId: VALID_AGENT,
      endpoint: "https://push.example.com/abc",
      p256dh: "PUB",
      auth: "AUTH",
    });
  });

  test("rejects a malformed subscription with 400", async () => {
    upsertMock.mockClear();
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "not-a-uuid", subscription: {} }),
    });
    expect(res.status).toBe(400);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  test("rejects a non-URL endpoint with 400", async () => {
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: VALID_AGENT,
        subscription: { endpoint: "nope", keys: { p256dh: "a", auth: "b" } },
      }),
    });
    expect(res.status).toBe(400);
  });

  test.each([
    ["http (not https)", "http://push.example.com/abc"],
    ["localhost", "https://localhost/abc"],
    ["loopback IPv4", "https://127.0.0.1/abc"],
    ["private 10.x", "https://10.0.0.5/abc"],
    ["private 192.168.x", "https://192.168.1.10/abc"],
    ["private 172.16.x", "https://172.16.0.1/abc"],
    ["link-local metadata", "https://169.254.169.254/latest/meta-data"],
    ["*.internal", "https://redis.internal/abc"],
  ])("rejects a %s endpoint (SSRF guard) with 400", async (_label, endpoint) => {
    upsertMock.mockClear();
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: VALID_AGENT,
        subscription: { endpoint, keys: { p256dh: "a", auth: "b" } },
      }),
    });
    expect(res.status).toBe(400);
    expect(upsertMock).not.toHaveBeenCalled();
  });

  test.each([
    ["Apple push", "https://web.push.apple.com/abc123"],
    ["FCM", "https://fcm.googleapis.com/fcm/send/xyz"],
    ["Mozilla", "https://updates.push.services.mozilla.com/wpush/v2/abc"],
  ])("accepts a real %s endpoint", async (_label, endpoint) => {
    upsertMock.mockClear();
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: VALID_AGENT,
        subscription: { endpoint, keys: { p256dh: "a", auth: "b" } },
      }),
    });
    expect(res.status).toBe(200);
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});

describe("DELETE /api/v1/web-push/subscriptions", () => {
  test("removes a subscription by endpoint scoped to the authed user", async () => {
    deleteByEndpointMock.mockClear();
    const res = await app.request("/", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example.com/abc" }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true, removed: 1 });
    expect(deleteByEndpointMock).toHaveBeenCalledWith(
      "user-1",
      "https://push.example.com/abc",
    );
  });

  test("400s a delete with no endpoint", async () => {
    const res = await app.request("/", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
