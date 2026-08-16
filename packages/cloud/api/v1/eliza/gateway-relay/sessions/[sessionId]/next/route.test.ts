/**
 * Fail-closed timeoutMs contract for the gateway-relay long-poll.
 *
 * GET .../sessions/:sessionId/next must reject prefix-coercible garbage
 * (parseInt("1e4", 10) === 1) before pollNextRequest. Missing or empty
 * timeoutMs stays at the documented 25s cap.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { Hono } from "hono";

const authenticatedUser = {
  id: "user-1",
  organization_id: "org-1",
};

const ownedSession = {
  id: "session-1",
  organizationId: "org-1",
  userId: "user-1",
  runtimeAgentId: "runtime-1",
  agentName: "relay",
  platform: "local-runtime" as const,
  createdAt: "2026-08-16T00:00:00.000Z",
  lastSeenAt: "2026-08-16T00:00:00.000Z",
};

const getSession = mock(async (_sessionId: string) => ownedSession);
const pollNextRequest = mock(
  async (_sessionId: string, _timeoutMs: number) => null,
);

mock.module("@/lib/auth/workers-hono-auth", () => ({
  requireUserOrApiKeyWithOrg: mock(async () => authenticatedUser),
}));
mock.module("@/lib/api/cloud-worker-errors", () => ({
  failureResponse: (_c: unknown, error: unknown) => {
    throw error;
  },
}));
mock.module("@/lib/services/agent-gateway-relay", () => ({
  agentGatewayRelayService: {
    getSession,
    pollNextRequest,
  },
}));

const { default: nextRoute, parseTimeoutMs } = await import("./route");
const app = new Hono().route("/:sessionId/next", nextRoute);

function getNext(query = "") {
  return app.request(`/session-1/next${query}`);
}

describe("parseTimeoutMs", () => {
  it.each([
    [undefined, 25_000],
    ["", 25_000],
    ["1", 1],
    ["5000", 5000],
    ["25000", 25_000],
  ] as const)("accepts %s", (raw, expected) => {
    expect(parseTimeoutMs(raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    ["scientific notation", "1e4"],
    ["trailing junk", "12px"],
    ["leading zero", "007"],
    ["signed", "-1"],
    ["zero", "0"],
    ["prefix junk", "25000abc"],
  ] as const)("rejects %s %s", (_label, raw) => {
    const result = parseTimeoutMs(raw);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("timeoutMs");
    expect(result.error).toContain(raw);
  });
});

const invalidTimeoutMs = [
  ["scientific notation", "1e4"],
  ["trailing junk", "12px"],
  ["leading zero", "007"],
  ["signed", "-1"],
  ["zero", "0"],
  ["prefix junk", "25000abc"],
  ["signed plus", "+1"],
  ["fractional", "1.5"],
  ["hex", "0x10"],
  ["whitespace only", "   "],
  ["leading whitespace", " 5000"],
  ["trailing whitespace", "5000 "],
  ["over the 25s cap", "25001"],
] as const;

describe("GET /api/v1/eliza/gateway-relay/sessions/:sessionId/next timeoutMs", () => {
  beforeEach(() => {
    getSession.mockClear();
    getSession.mockResolvedValue(ownedSession);
    pollNextRequest.mockClear();
    pollNextRequest.mockResolvedValue(null);
  });

  it("omitted timeoutMs uses the 25s cap and polls", async () => {
    const response = await getNext();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { request: null };
    };
    expect(body).toEqual({
      success: true,
      data: { request: null },
    });
    expect(pollNextRequest).toHaveBeenCalledTimes(1);
    expect(pollNextRequest).toHaveBeenCalledWith("session-1", 25_000);
  });

  it("empty timeoutMs uses the 25s cap and polls", async () => {
    const response = await getNext("?timeoutMs=");
    expect(response.status).toBe(200);
    expect(pollNextRequest).toHaveBeenCalledWith("session-1", 25_000);
  });

  it.each([
    ["1", 1],
    ["5000", 5000],
    ["25000", 25_000],
  ] as const)("canonical timeoutMs=%s polls with %s", async (raw, expected) => {
    const response = await getNext(`?timeoutMs=${raw}`);
    expect(response.status).toBe(200);
    expect(pollNextRequest).toHaveBeenCalledTimes(1);
    expect(pollNextRequest).toHaveBeenCalledWith("session-1", expected);
  });

  it.each(invalidTimeoutMs)(
    "returns 400 and does not poll for %s timeoutMs=%s",
    async (_label, raw) => {
      const response = await getNext(`?timeoutMs=${encodeURIComponent(raw)}`);
      expect(response.status).toBe(400);
      const body = (await response.json()) as { success: false; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toContain("timeoutMs");
      expect(body.error).toContain(raw);
      expect(pollNextRequest).not.toHaveBeenCalled();
    },
  );
});
