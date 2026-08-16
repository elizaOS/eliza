/**
 * Exercises the gateway-relay long-poll route with deterministic auth and
 * service boundaries, including rejection before polling for invalid timeouts.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";

const getSession = mock(async () => ({
  organizationId: "org-1",
  userId: "user-1",
}));
const pollNextRequest = mock(async () => null);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: "user-1",
    organization_id: "org-1",
  })),
}));

mock.module("@/lib/services/agent-gateway-relay", () => ({
  agentGatewayRelayService: {
    getSession,
    pollNextRequest,
  },
}));

const { default: nextRoute } = await import("./route");

const app = new Hono();
app.route("/api/v1/eliza/gateway-relay/sessions/:sessionId/next", nextRoute);

async function requestWithTimeout(timeoutMs?: string): Promise<Response> {
  const query = timeoutMs === undefined ? "" : `?timeoutMs=${timeoutMs}`;
  return app.request(
    `/api/v1/eliza/gateway-relay/sessions/session-1/next${query}`,
  );
}

beforeEach(() => {
  getSession.mockClear();
  pollNextRequest.mockClear();
});

describe("gateway-relay next-request timeout", () => {
  test.each([
    "+1",
    "-1",
    "0",
    "1.5",
    "0x10",
    "1e3",
    "01",
    "%201",
    "1%20",
    "10junk",
    "25001",
  ])("rejects non-canonical timeout token %s before polling", async (token) => {
    const response = await requestWithTimeout(token);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ success: false });
    expect(pollNextRequest).not.toHaveBeenCalled();
  });

  test.each([
    [undefined, 25_000],
    ["", 25_000],
    ["1", 1],
    ["24999", 24_999],
    ["25000", 25_000],
  ] as const)("maps timeout token %s to %i", async (token, expected) => {
    const response = await requestWithTimeout(token);

    expect(response.status).toBe(200);
    expect(pollNextRequest).toHaveBeenCalledTimes(1);
    expect(pollNextRequest).toHaveBeenCalledWith("session-1", expected);
  });
});
