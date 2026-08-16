/**
 * Exercises the gateway-relay next-session route trust boundary: strict
 * positive-integer timeoutMs parsing before the long-poll call, so a
 * client-supplied malformed value can never become a coerced 1ms wait.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getSession = mock(async () => ({
  id: "session-1",
  organizationId: "org-1",
  userId: "user-1",
}));
const pollNextRequest = mock(async () => ({
  requestId: "req-1",
  payload: { test: "data" },
}));
const requireUserOrApiKeyWithOrg = mock(async () => ({
  id: "user-1",
  organization_id: "org-1",
}));

mock.module("@/lib/services/agent-gateway-relay", () => ({
  agentGatewayRelayService: { getSession, pollNextRequest },
}));
mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg,
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (c: any, error: any) =>
    c.json({ success: false, error: String(error) }, 500),
}));

const route = (
  await import("../v1/eliza/gateway-relay/sessions/[sessionId]/next/route")
).default;
const app = new Hono().route(
  "/api/v1/eliza/gateway-relay/sessions/:sessionId/next",
  route,
);

function nextRequest(query = "") {
  return app.request(
    `/api/v1/eliza/gateway-relay/sessions/session-1/next${query}`,
  );
}

describe("GET /api/v1/eliza/gateway-relay/sessions/:sessionId/next timeoutMs parsing", () => {
  beforeEach(() => {
    requireUserOrApiKeyWithOrg.mockClear();
    getSession.mockClear();
    pollNextRequest.mockClear();
    getSession.mockResolvedValue({
      id: "session-1",
      organizationId: "org-1",
      userId: "user-1",
    });
    pollNextRequest.mockResolvedValue({
      requestId: "req-1",
      payload: { test: "data" },
    });
    requireUserOrApiKeyWithOrg.mockResolvedValue({
      id: "user-1",
      organization_id: "org-1",
    });
  });

  test("defaults to 25000 when timeoutMs is absent", async () => {
    const response = await nextRequest();
    expect(response.status).toBe(200);
    expect(pollNextRequest).toHaveBeenCalledWith("session-1", 25000);
  });

  test.each([1, 1000, 25000])(
    "passes a valid positive integer of %i through the cap",
    async (timeoutMs) => {
      const response = await nextRequest(`?timeoutMs=${timeoutMs}`);
      expect(response.status).toBe(200);
      expect(pollNextRequest).toHaveBeenCalledWith("session-1", timeoutMs);
    },
  );

  test("caps a valid positive integer above 25000 at 25000", async () => {
    const response = await nextRequest("?timeoutMs=50000");
    expect(response.status).toBe(200);
    expect(pollNextRequest).toHaveBeenCalledWith("session-1", 25000);
  });

  test.each([
    ["empty", ""],
    ["negative", "-1"],
    ["zero", "0"],
    ["malformed prefix", "12px"],
    ["fractional", "1.5"],
    ["exponent form", "1e4"],
    ["malformed suffix", "25000abc"],
    ["non-finite", "Infinity"],
    ["unsafe integer", "9007199254740992"],
  ])(
    "defaults %s timeoutMs to 25000 without calling service",
    async (_name, timeoutMs) => {
      const response = await nextRequest(
        `?timeoutMs=${encodeURIComponent(timeoutMs)}`,
      );
      expect(response.status).toBe(200);
      expect(pollNextRequest).toHaveBeenCalledWith("session-1", 25000);
    },
  );
});
