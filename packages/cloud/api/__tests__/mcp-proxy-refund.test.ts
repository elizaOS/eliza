/**
 * Regression (#11637): the MCP metered proxy debits the caller upfront, so
 * EVERY post-debit failure must refund — not only a non-ok HTTP status. Before
 * the fix an unreachable upstream / unsafe endpoint / down container returned
 * 502/400/503 while keeping the money = a silent over-charge.
 *
 * Drives the real route handler with mocked deps and asserts `refundCredits` is
 * called on each failure branch and NOT on success. Red on develop tip (only
 * the non-ok branch refunded); green after the fix.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";

// mock.module is process-global — spread the real auth module so only
// requireUserOrApiKeyWithOrg is overridden (mirrors agent-mcp-billing.test.ts).
const requireUserOrApiKeyWithOrg = mock();
const realAuth = await import("@/lib/auth/workers-hono-auth");
mock.module("@/lib/auth/workers-hono-auth", () => ({
  ...realAuth,
  requireUserOrApiKeyWithOrg,
}));

const assertSafeOutboundUrl = mock();
mock.module("@/lib/security/outbound-url", () => ({ assertSafeOutboundUrl }));

const safeFetch = mock();
mock.module("@/lib/security/safe-fetch", () => ({ safeFetch }));

const getReferrer = mock();
mock.module("@/lib/services/affiliates", () => ({
  affiliatesService: { getReferrer },
}));

const containersGetById = mock();
mock.module("@/lib/services/containers", () => ({
  containersService: { getById: containersGetById },
}));

const reserveAndDeductCredits = mock();
const refundCredits = mock();
mock.module("@/lib/services/credits", () => ({
  creditsService: { reserveAndDeductCredits, refundCredits },
}));

const getById = mock();
const recordUsageWithoutDeduction = mock(async () => {});
mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: {
    getById,
    recordUsageWithoutDeduction,
  },
}));

mock.module("@/lib/utils/logger", () => ({
  logger: { error: mock(), info: mock(), warn: mock(), debug: mock() },
}));

const mcpRoute = (await import("../mcp/proxy/[mcpId]/route")).default;
const app = new Hono();
app.route("/:mcpId", mcpRoute);

function post(
  body = JSON.stringify({ method: "tools/call", params: { name: "t" } }),
) {
  return app.request("/test-mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

const EXTERNAL_MCP = {
  id: "test-mcp",
  name: "Test MCP",
  status: "live",
  credits_per_request: "5",
  endpoint_type: "external",
  external_endpoint: "https://mcp.example.test/rpc",
  organization_id: "org1",
};

beforeEach(() => {
  requireUserOrApiKeyWithOrg.mockResolvedValue({
    id: "u1",
    organization_id: "org1",
  });
  getById.mockResolvedValue({ ...EXTERNAL_MCP });
  getReferrer.mockReset();
  getReferrer.mockResolvedValue(null);
  recordUsageWithoutDeduction.mockClear();
  reserveAndDeductCredits.mockClear();
  reserveAndDeductCredits.mockResolvedValue({
    success: true,
    transaction: { id: "tx1" },
    newBalance: 95,
  });
  refundCredits.mockReset();
  refundCredits.mockResolvedValue({ newBalance: 100 });
  assertSafeOutboundUrl.mockResolvedValue(
    new URL("https://mcp.example.test/rpc"),
  );
  safeFetch.mockReset();
  containersGetById.mockReset();
});

test("unreachable upstream (502) refunds the upfront debit (#11637)", async () => {
  safeFetch.mockRejectedValue(new Error("ECONNREFUSED"));
  const res = await post();
  expect(res.status).toBe(502);
  expect(reserveAndDeductCredits).toHaveBeenCalledTimes(1);
  expect(refundCredits).toHaveBeenCalledTimes(1);
});

test("non-owner org CANNOT invoke another org's PRIVATE MCP — 404, no billing (#11838)", async () => {
  // user is org1 (beforeEach); the MCP is private and owned by org2.
  getById.mockResolvedValue({
    ...EXTERNAL_MCP,
    is_public: false,
    organization_id: "org2",
  });
  const res = await post();
  expect(res.status).toBe(404);
  expect(reserveAndDeductCredits).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
});

test("non-owner org CAN invoke a PUBLIC MCP — monetization model preserved (#11838)", async () => {
  getById.mockResolvedValue({
    ...EXTERNAL_MCP,
    is_public: true,
    organization_id: "org2",
  });
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(200);
  expect(reserveAndDeductCredits).toHaveBeenCalledTimes(1);
});

test("unsafe/blocked external endpoint (400) refunds (#11637)", async () => {
  assertSafeOutboundUrl.mockRejectedValue(new Error("SSRF blocked"));
  const res = await post();
  expect(res.status).toBe(400);
  expect(refundCredits).toHaveBeenCalledTimes(1);
});

test("container-unavailable (503) refunds (#11637)", async () => {
  getById.mockResolvedValue({
    id: "test-mcp",
    name: "Container MCP",
    status: "live",
    credits_per_request: "5",
    endpoint_type: "container",
    container_id: "c1",
    organization_id: "org1",
  });
  containersGetById.mockResolvedValue(null); // no load_balancer_url
  const res = await post();
  expect(res.status).toBe(503);
  expect(refundCredits).toHaveBeenCalledTimes(1);
});

test("container lookup failure (502) refunds after upfront debit (#11637)", async () => {
  getById.mockResolvedValue({
    id: "test-mcp",
    name: "Container MCP",
    status: "live",
    credits_per_request: "5",
    endpoint_type: "container",
    container_id: "c1",
    organization_id: "org1",
  });
  containersGetById.mockRejectedValue(new Error("container DB down"));
  const res = await post();
  expect(res.status).toBe(502);
  expect(refundCredits).toHaveBeenCalledTimes(1);
});

test("invalid JSON body (400) refunds after the upfront debit (#11637)", async () => {
  const res = await post("{not json");
  expect(res.status).toBe(400);
  expect(reserveAndDeductCredits).toHaveBeenCalledTimes(1);
  expect(refundCredits).toHaveBeenCalledTimes(1);
});

test("oversized request body returns 413, refunds exact receipt, and skips upstream", async () => {
  const res = await post(`{"payload":"${"x".repeat(1_000_001)}"}`);
  expect(res.status).toBe(413);
  expect(refundCredits).toHaveBeenCalledWith(
    expect.objectContaining({
      amount: 0.05,
      metadata: expect.objectContaining({ reason: "request_body_too_large" }),
    }),
  );
  expect(safeFetch).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("non-ok upstream status refunds (existing behavior preserved)", async () => {
  safeFetch.mockResolvedValue(new Response("upstream error", { status: 500 }));
  const res = await post();
  expect(res.status).toBe(500);
  expect(refundCredits).toHaveBeenCalledTimes(1);
});

test("upstream response body read failure refunds before usage is recorded", async () => {
  safeFetch.mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: async () => {
      throw new Error("body stream failed");
    },
  } as unknown as Response);
  const res = await post();
  expect(res.status).toBe(502);
  expect(refundCredits).toHaveBeenCalledWith(
    expect.objectContaining({
      amount: 0.05,
      metadata: expect.objectContaining({ reason: "mcp_response_read_failed" }),
    }),
  );
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("declared oversized upstream body returns 502 and refunds exact receipt", async () => {
  safeFetch.mockResolvedValue(
    new Response("not read", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "5000001",
      },
    }),
  );
  const res = await post();
  expect(res.status).toBe(502);
  expect(refundCredits).toHaveBeenCalledWith(
    expect.objectContaining({
      amount: 0.05,
      metadata: expect.objectContaining({ reason: "mcp_response_too_large" }),
    }),
  );
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("successful call does NOT refund", async () => {
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(200);
  expect(refundCredits).not.toHaveBeenCalled();
});

test("affiliate surcharge uses one exact debit, persisted receipt, and refund authority", async () => {
  getReferrer.mockResolvedValue({
    user_id: "affiliate-user",
    id: "affiliate-code",
    markup_percent: "10",
  });
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const success = await post();
  expect(success.status).toBe(200);
  expect(reserveAndDeductCredits.mock.calls[0]?.[0].amount).toBe(0.065);
  expect(recordUsageWithoutDeduction).toHaveBeenCalledWith(
    expect.objectContaining({
      creditsCharged: 5,
      affiliateFeeCredits: 0.5,
      platformFeeCredits: 1,
      chargeReceipt: {
        creditUnit: "USD",
        baseAmountUsd: 0.05,
        affiliateFeeUsd: 0.005,
        platformFeeUsd: 0.01,
        totalAmountUsd: 0.065,
        feeComponentsKnown: true,
      },
    }),
  );

  safeFetch.mockRejectedValue(new Error("offline"));
  const failure = await post();
  expect(failure.status).toBe(502);
  expect(refundCredits.mock.calls[0]?.[0].amount).toBe(0.065);
});
