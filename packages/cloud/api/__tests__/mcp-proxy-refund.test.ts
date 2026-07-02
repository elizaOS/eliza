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

mock.module("@/lib/services/affiliates", () => ({
  affiliatesService: { getReferrer: async () => null },
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
mock.module("@/lib/services/user-mcps", () => ({
  userMcpsService: {
    getById,
    recordUsageWithoutDeduction: mock(async () => {}),
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

test("invalid JSON body (400) refunds after the upfront debit (#11637)", async () => {
  const res = await post("{not json");
  expect(res.status).toBe(400);
  expect(reserveAndDeductCredits).toHaveBeenCalledTimes(1);
  expect(refundCredits).toHaveBeenCalledTimes(1);
});

test("non-ok upstream status refunds (existing behavior preserved)", async () => {
  safeFetch.mockResolvedValue(new Response("upstream error", { status: 500 }));
  const res = await post();
  expect(res.status).toBe(500);
  expect(refundCredits).toHaveBeenCalledTimes(1);
});

test("successful call does NOT refund", async () => {
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(200);
  expect(refundCredits).not.toHaveBeenCalled();
});
