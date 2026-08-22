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
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { __mcpProxyHopTestHooks } from "../mcp/proxy/[mcpId]/proxy-body-budget";

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

afterEach(() => {
  __mcpProxyHopTestHooks.resetHopTimeoutMs();
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

test("headers-resolve body-never-resolves returns 504, refunds exact receipt, and skips usage", async () => {
  __mcpProxyHopTestHooks.setHopTimeoutMs(25);
  safeFetch.mockImplementation((_url: string, init?: RequestInit) => {
    void init;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        /* never enqueue */
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
  const res = await post();
  expect(res.status).toBe(504);
  const timedOut = (await res.json()) as { error: string };
  expect(timedOut).toEqual({ error: "MCP endpoint timed out" });
  expect(refundCredits).toHaveBeenCalledWith(
    expect.objectContaining({
      amount: 0.05,
      metadata: expect.objectContaining({
        reason: "upstream_deadline_exceeded",
      }),
    }),
  );
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("streamed oversized upstream body returns 502 and refunds exact receipt", async () => {
  const first = new Uint8Array(5_000_000);
  const overflow = new Uint8Array(2);
  first.fill(97);
  overflow.fill(98);
  safeFetch.mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
          controller.enqueue(overflow);
          controller.close();
        },
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    ),
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

test("container hop headers-resolve body-never-resolves returns 504 and refunds", async () => {
  __mcpProxyHopTestHooks.setHopTimeoutMs(25);
  getById.mockResolvedValue({
    id: "test-mcp",
    name: "Container MCP",
    status: "live",
    credits_per_request: "5",
    endpoint_type: "container",
    container_id: "c1",
    organization_id: "org1",
  });
  containersGetById.mockResolvedValue({
    load_balancer_url: "http://container.internal",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    void input;
    void init;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        /* never enqueue */
      },
    });
    return Promise.resolve(
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  try {
    const res = await post();
    expect(res.status).toBe(504);
    expect(refundCredits).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 0.05,
        metadata: expect.objectContaining({
          reason: "upstream_deadline_exceeded",
        }),
      }),
    );
    expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
    expect(safeFetch).not.toHaveBeenCalled();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("headers-never-resolve fetch abort refunds exact receipt and skips usage", async () => {
  __mcpProxyHopTestHooks.setHopTimeoutMs(25);
  safeFetch.mockImplementation((_url: string, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      signal?.addEventListener(
        "abort",
        () => {
          reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
        },
        { once: true },
      );
    });
  });
  const res = await post();
  expect(res.status).toBe(504);
  expect(refundCredits).toHaveBeenCalledWith(
    expect.objectContaining({
      amount: 0.05,
      metadata: expect.objectContaining({
        reason: "upstream_deadline_exceeded",
      }),
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

test("stalled endpoint prevalidation returns 504, refunds exact receipt, and skips usage", async () => {
  __mcpProxyHopTestHooks.setHopTimeoutMs(20);
  assertSafeOutboundUrl.mockReturnValue(
    new Promise(() => {
      /* never settles — attacker-controlled DNS during prevalidation */
    }),
  );
  const hung = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("prevalidation ignored hop deadline")),
      80,
    );
  });
  const res = await Promise.race([post(), hung]);
  expect(res.status).toBe(504);
  const prevalidationTimedOut = (await res.json()) as { error: string };
  expect(prevalidationTimedOut).toEqual({ error: "MCP endpoint timed out" });
  expect(refundCredits).toHaveBeenCalledWith(
    expect.objectContaining({
      amount: 0.05,
      metadata: expect.objectContaining({
        reason: "upstream_deadline_exceeded",
      }),
    }),
  );
  expect(safeFetch).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("stalled pre-socket DNS in safeFetch returns 504, refunds exact receipt, and skips usage", async () => {
  __mcpProxyHopTestHooks.setHopTimeoutMs(20);
  safeFetch.mockImplementation(() => {
    return new Promise(() => {
      /* never settles and ignores hop.signal — DNS lookup that never returns */
    });
  });
  const hung = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("pre-socket DNS ignored hop deadline")),
      80,
    );
  });
  const res = await Promise.race([post(), hung]);
  expect(res.status).toBe(504);
  const dnsTimedOut = (await res.json()) as { error: string };
  expect(dnsTimedOut).toEqual({ error: "MCP endpoint timed out" });
  expect(refundCredits).toHaveBeenCalledWith(
    expect.objectContaining({
      amount: 0.05,
      metadata: expect.objectContaining({
        reason: "upstream_deadline_exceeded",
      }),
    }),
  );
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("caller-aborted inbound JSON read returns 504, refunds exact receipt, and skips usage", async () => {
  const caller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    pull() {
      /* never enqueue — inbound parse waits on the caller body */
    },
  });
  const pending = app.request("/test-mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: caller.signal,
  });
  queueMicrotask(() => {
    caller.abort(new Error("caller canceled"));
  });
  const hung = new Promise<never>((_, reject) => {
    setTimeout(
      () => reject(new Error("inbound JSON read ignored caller abort")),
      80,
    );
  });
  const res = await Promise.race([pending, hung]);
  expect(res.status).toBe(504);
  const inboundTimedOut = (await res.json()) as { error: string };
  expect(inboundTimedOut).toEqual({ error: "MCP endpoint timed out" });
  expect(refundCredits).toHaveBeenCalledWith(
    expect.objectContaining({
      amount: 0.05,
      metadata: expect.objectContaining({
        reason: "upstream_deadline_exceeded",
      }),
    }),
  );
  expect(safeFetch).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
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
