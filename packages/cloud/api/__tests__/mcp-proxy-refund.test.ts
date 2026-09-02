/**
 * Exercises MCP proxy standing, flat admission, dispatch ordering, and retained
 * settlement through the real Hono route with deterministic boundary mocks.
 *
 * Failures before upstream dispatch release admission; uncertain failures after
 * dispatch settle conservatively instead of fabricating a zero-cost call.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import { __mcpProxyHopTestHooks } from "../mcp/proxy/[mcpId]/proxy-body-budget";

const requireGenerativeRouteCaller = mock();
const admitFlatGenerativeOperation = mock();
let executionCtx: { waitUntil(promise: Promise<unknown>): void } | undefined;

// Mirrors resolveInferenceCredentialAdmissionDenial's bounded public taxonomy
// for the two revocation-boundary error classes the route can surface from the
// pre-dispatch free-tier strong check (real route maps them through
// asGenerativeCacheApiError; every other error still maps to null here).
class InferenceCredentialRevokedError extends Error {
  constructor(public readonly reason: string) {
    super("Inference credential is revoked");
    this.name = "InferenceCredentialRevokedError";
  }
}
class InferenceCredentialRevocationUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InferenceCredentialRevocationUnavailableError";
  }
}
const assertInferenceCredentialActive = mock(
  async (_organizationId: string, _credential: unknown) => undefined,
);
mock.module("@/lib/services/inference-credential-revocation", () => ({
  assertInferenceCredentialActive,
  InferenceCredentialRevokedError,
  InferenceCredentialRevocationUnavailableError,
}));

function revokedReasonToStanding(reason: string): {
  status: number;
  reason: string;
} {
  switch (reason) {
    case "credential_revoked":
    case "session_revoked":
    case "session_binding_revoked":
      return { status: 401, reason: "credential_inactive" };
    case "organization_disabled":
      return { status: 403, reason: "organization_inactive" };
    case "subject_account_disabled":
      return { status: 403, reason: "account_inactive" };
    case "subject_membership_disabled":
      return { status: 403, reason: "membership_missing" };
    case "subject_moderation_disabled":
      return { status: 403, reason: "moderation_blocked" };
    default:
      return { status: 403, reason: "credential_invalid" };
  }
}

mock.module("@/api-app/lib/generative-route-auth", () => ({
  admitFlatGenerativeOperation,
  asGenerativeCacheApiError: (error: unknown) => {
    if (error instanceof InferenceCredentialRevokedError) {
      const standing = revokedReasonToStanding(error.reason);
      return new ApiError(
        standing.status,
        "access_denied",
        "Account is not eligible for generative work",
        { reason: standing.reason },
      );
    }
    if (error instanceof InferenceCredentialRevocationUnavailableError) {
      return new ApiError(
        503,
        "service_unavailable",
        "Authorization service is unavailable. Retry shortly.",
        { retryable: true, retryAfterSeconds: 1 },
      );
    }
    return null;
  },
  getGenerativeExecutionContext: () => executionCtx,
  requireGenerativeRouteCaller,
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

class InsufficientCreditsError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number,
  ) {
    super("Insufficient credits");
  }
}
mock.module("@/lib/services/credits", () => ({
  InsufficientCreditsError,
}));

const settle = mock(async () => null);
const settleUnknown = mock(async () => null);
const markProviderDispatched = mock(async () => undefined);

const getById = mock();
const recordUsageWithoutDeduction = mock(async () => {});
const recordZeroCostUsage = mock(async () => {});
// The route's fail-closed numeric gate (#22961) runs before admission. The
// real gate's behavior is pinned at the service boundary
// (user-mcps-recordusage-numeric.test.ts); here it is a boundary spy like
// every other mocked collaborator, available for ordering/call assertions.
const assertSettleableMcpRow = mock(() => undefined);
mock.module("@/lib/services/user-mcps", () => ({
  assertSettleableMcpRow,
  userMcpsService: {
    getById,
    recordZeroCostUsage,
    recordUsageWithoutDeduction,
  },
}));

const loggerError = mock();
const loggerWarn = mock();
mock.module("@/lib/utils/logger", () => ({
  logger: { error: loggerError, info: mock(), warn: loggerWarn, debug: mock() },
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
  executionCtx = undefined;
  requireGenerativeRouteCaller.mockReset();
  requireGenerativeRouteCaller.mockResolvedValue({
    user: { id: "u1", organization_id: "org1" },
    apiKeyId: "key1",
    authSource: "combined_cache",
    admissionSnapshot: { standing: "active" },
    appScopeId: null,
    credential: { kind: "api_key", credentialId: "key1", userId: "u1" },
  });
  assertInferenceCredentialActive.mockReset();
  assertInferenceCredentialActive.mockResolvedValue(undefined);
  settle.mockReset();
  settle.mockResolvedValue(null);
  settleUnknown.mockReset();
  settleUnknown.mockResolvedValue(null);
  markProviderDispatched.mockReset();
  markProviderDispatched.mockResolvedValue(undefined);
  admitFlatGenerativeOperation.mockReset();
  admitFlatGenerativeOperation.mockResolvedValue({
    settle,
    settleUnknown,
    markProviderDispatched,
    reservation: { reservationTransactionId: "reservation-1" },
  });
  getById.mockResolvedValue({ ...EXTERNAL_MCP });
  getReferrer.mockReset();
  getReferrer.mockResolvedValue(null);
  recordUsageWithoutDeduction.mockClear();
  recordZeroCostUsage.mockReset();
  recordZeroCostUsage.mockResolvedValue(undefined);
  assertSafeOutboundUrl.mockResolvedValue(
    new URL("https://mcp.example.test/rpc"),
  );
  safeFetch.mockReset();
  containersGetById.mockReset();
  loggerError.mockClear();
  loggerWarn.mockClear();
});

afterEach(() => {
  __mcpProxyHopTestHooks.resetHopTimeoutMs();
});

test("cached standing denial preserves its reason and skips admission", async () => {
  requireGenerativeRouteCaller.mockRejectedValue(
    new ApiError(403, "access_denied", "Organization is inactive", {
      reason: "organization_inactive",
    }),
  );

  const res = await post();
  const body = (await res.json()) as {
    details?: { reason?: string };
  };

  expect(res.status).toBe(403);
  expect(body.details?.reason).toBe("organization_inactive");
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
  expect(loggerWarn).toHaveBeenCalledWith(
    "[MCP Proxy] Caller admission denied",
    expect.objectContaining({
      mcpId: "test-mcp",
      reason: "organization_inactive",
      errorName: "ApiError",
    }),
  );
});

test("admits before marking dispatch and marks immediately before fetch", async () => {
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );

  const res = await post();

  expect(res.status).toBe(200);
  expect(requireGenerativeRouteCaller.mock.invocationCallOrder[0]).toBeLessThan(
    assertSafeOutboundUrl.mock.invocationCallOrder[0],
  );
  expect(assertSafeOutboundUrl.mock.invocationCallOrder[0]).toBeLessThan(
    admitFlatGenerativeOperation.mock.invocationCallOrder[0],
  );
  expect(admitFlatGenerativeOperation.mock.invocationCallOrder[0]).toBeLessThan(
    markProviderDispatched.mock.invocationCallOrder[0],
  );
  expect(markProviderDispatched.mock.invocationCallOrder[0]).toBeLessThan(
    safeFetch.mock.invocationCallOrder[0],
  );
});

test("retains successful settlement and usage under waitUntil", async () => {
  const retained: Promise<unknown>[] = [];
  const waitUntil = mock((promise: Promise<unknown>) => {
    retained.push(promise);
  });
  executionCtx = { waitUntil };
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );

  const res = await post();

  expect(res.status).toBe(200);
  expect(waitUntil).toHaveBeenCalledTimes(1);
  await Promise.all(retained);
  expect(settle).toHaveBeenCalledWith(0.05);
  expect(recordUsageWithoutDeduction).toHaveBeenCalledTimes(1);
});

test("unreachable upstream settles unknown after dispatch", async () => {
  safeFetch.mockRejectedValue(new Error("ECONNREFUSED"));
  const res = await post();
  expect(res.status).toBe(502);
  expect(admitFlatGenerativeOperation).toHaveBeenCalledTimes(1);
  expect(markProviderDispatched).toHaveBeenCalledTimes(1);
  expect(settleUnknown).toHaveBeenCalledTimes(1);
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
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
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
  expect(admitFlatGenerativeOperation).toHaveBeenCalledTimes(1);
});

test("unsafe/blocked external endpoint is rejected before admission", async () => {
  assertSafeOutboundUrl.mockRejectedValue(new Error("SSRF blocked"));
  const res = await post();
  expect(res.status).toBe(400);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(markProviderDispatched).not.toHaveBeenCalled();
});

test("container-unavailable is rejected before admission", async () => {
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
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test("container lookup failure is rejected before admission", async () => {
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
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test("invalid JSON body is rejected before admission", async () => {
  const res = await post("{not json");
  expect(res.status).toBe(400);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test("oversized request body returns 413 before admission and skips upstream", async () => {
  const res = await post(`{"payload":"${"x".repeat(1_000_001)}"}`);
  expect(res.status).toBe(413);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("non-ok upstream status settles unknown after dispatch", async () => {
  safeFetch.mockResolvedValue(new Response("upstream error", { status: 500 }));
  const res = await post();
  expect(res.status).toBe(500);
  expect(settleUnknown).toHaveBeenCalledTimes(1);
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
  expect(settleUnknown).toHaveBeenCalledTimes(1);
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
  expect(settleUnknown).toHaveBeenCalledTimes(1);
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
  expect(settleUnknown).toHaveBeenCalledTimes(1);
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
  expect(settleUnknown).toHaveBeenCalledTimes(1);
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
    expect(settleUnknown).toHaveBeenCalledTimes(1);
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
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("successful call settles exact cost and records usage", async () => {
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(200);
  expect(settle).toHaveBeenCalledWith(0.05);
  expect(settleUnknown).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).toHaveBeenCalledTimes(1);
});

test("settlement receipt is keyed on the admission rail's durable charge row (#22961 rebase)", async () => {
  // Durable-admission mode: settle() commits the deferred debit and reports
  // its id through settlementTransactionIds — the settlement receipt's
  // payment event must be THAT uuid, never the requestId fallback that
  // claimPrechargeForSettlement cannot cast.
  const durableId = "5f2c0a34-9b1e-4c8d-a6f7-2e8d1b3c4d5e";
  settle.mockImplementationOnce(
    async () =>
      ({
        reservedAmount: 0.05,
        actualCost: 0.05,
        settlementTransactionIds: [durableId],
        adjustmentType: "none",
      }) as unknown as null,
  );
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(200);
  expect(settle).toHaveBeenCalledWith(0.05);
  expect(recordUsageWithoutDeduction).toHaveBeenCalledTimes(1);
  expect(
    (
      recordUsageWithoutDeduction.mock.calls[0] as unknown as [
        { metadata?: { preChargeTransactionId?: string } },
      ]
    )[0]?.metadata,
  ).toMatchObject({
    preChargeTransactionId: durableId,
  });
});

test("free-tier MCP call skips the admission rail and records zero-cost usage (#22961 rebase)", async () => {
  // credits_per_request 0 => totalAmountUsd <= 0 => the flat cost contract
  // rejects it; admission must never be consulted and usage is recorded via
  // the zero-cost path with no settlement claim.
  getById.mockResolvedValueOnce({
    ...EXTERNAL_MCP,
    credits_per_request: "0",
  });
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(200);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(settleUnknown).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
  expect(recordZeroCostUsage).toHaveBeenCalledTimes(1);
  expect(
    (
      recordZeroCostUsage.mock.calls[0] as unknown as [
        { toolName?: string; metadata?: Record<string, unknown> },
      ]
    )[0],
  ).toMatchObject({
    // post() dispatches params.name "t"; the route forwards the real parsed
    // tool name (toolNameFromRpcBody), not the malformed-body "unknown" path.
    toolName: "t",
    metadata: { success: true },
  });
});

test("free-tier price change mid-flight cannot bill the buyer (#22961 rebase)", async () => {
  // The route snapshot says free (credits_per_request 0), so admission is
  // skipped; the MCP row flips to paid (5) BEFORE usage recording. The
  // zero-cost API must record 0 anyway — it never re-reads the price row,
  // so a mid-flight price change cannot produce a post-delivery charge.
  getById.mockResolvedValueOnce({
    ...EXTERNAL_MCP,
    credits_per_request: "0",
  });
  recordZeroCostUsage.mockImplementationOnce(async () => {
    // Simulate the price flip landing before the usage write.
    getById.mockResolvedValue({ ...EXTERNAL_MCP });
  });
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(200);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(settleUnknown).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
  expect(recordZeroCostUsage).toHaveBeenCalledTimes(1);
});

test("free-tier revoked credential is rejected before upstream dispatch (#27992)", async () => {
  // Regression: on the free tier the admission rail is skipped, so the
  // deferred strong credential check used to run only in the guard's async
  // disposal — after the upstream fetch. A revoked credential must never
  // reach safeFetch on a zero-cost call.
  getById.mockResolvedValueOnce({ ...EXTERNAL_MCP, credits_per_request: "0" });
  assertInferenceCredentialActive.mockRejectedValueOnce(
    new InferenceCredentialRevokedError("credential_revoked"),
  );
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  const body = (await res.json()) as { details?: { reason?: string } };
  expect(res.status).toBe(401);
  expect(body.details?.reason).toBe("credential_inactive");
  expect(assertInferenceCredentialActive).toHaveBeenCalledTimes(1);
  expect(assertInferenceCredentialActive).toHaveBeenCalledWith("org1", {
    kind: "api_key",
    credentialId: "key1",
    userId: "u1",
  });
  expect(safeFetch).not.toHaveBeenCalled();
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(recordZeroCostUsage).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test("free-tier active credential dispatches with exactly one strong check (#27992)", async () => {
  // The pre-dispatch check runs exactly once: consuming the proof through
  // the guard marks the admission boundary, so disposal never re-checks and
  // the zero-cost delivery proceeds normally.
  getById.mockResolvedValueOnce({ ...EXTERNAL_MCP, credits_per_request: "0" });
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(200);
  expect(assertInferenceCredentialActive).toHaveBeenCalledTimes(1);
  expect(safeFetch).toHaveBeenCalledTimes(1);
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(recordZeroCostUsage).toHaveBeenCalledTimes(1);
});

test("free-tier call without a deferred credential dispatches unchecked (#27992)", async () => {
  // Compatibility-auth callers carry no strong-check proof; nothing to
  // verify, so dispatch proceeds without the boundary roundtrip.
  requireGenerativeRouteCaller.mockResolvedValueOnce({
    user: { id: "u1", organization_id: "org1" },
    apiKeyId: null,
    authSource: "compatibility",
    appScopeId: null,
  });
  getById.mockResolvedValueOnce({ ...EXTERNAL_MCP, credits_per_request: "0" });
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(200);
  expect(assertInferenceCredentialActive).not.toHaveBeenCalled();
  expect(safeFetch).toHaveBeenCalledTimes(1);
});

test("free-tier revocation-boundary outage fails closed before dispatch (#27992)", async () => {
  // DO outage must not become unlimited free access for revoked credentials:
  // the free tier pays the same fail-closed 503 price as the paid rail.
  getById.mockResolvedValueOnce({ ...EXTERNAL_MCP, credits_per_request: "0" });
  assertInferenceCredentialActive.mockRejectedValueOnce(
    new InferenceCredentialRevocationUnavailableError(
      "Inference revocation boundary is unavailable",
    ),
  );
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  expect(res.status).toBe(503);
  expect(safeFetch).not.toHaveBeenCalled();
  expect(recordZeroCostUsage).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
});

test("paid-path control: revoked credential on a priced MCP denies before dispatch (#27992)", async () => {
  // Guards the ternary-to-if/else conversion: the paid rail still consumes
  // the credential proof inside admission and maps revocation identically.
  assertInferenceCredentialActive.mockRejectedValueOnce(
    new InferenceCredentialRevokedError("session_revoked"),
  );
  admitFlatGenerativeOperation.mockImplementationOnce(
    async (params: { credential?: { kind: string } }) => {
      if (params.credential) {
        await assertInferenceCredentialActive("org1", params.credential);
      }
      return { settle, settleUnknown, markProviderDispatched };
    },
  );
  safeFetch.mockResolvedValue(
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  const res = await post();
  const body = (await res.json()) as { details?: { reason?: string } };
  expect(res.status).toBe(401);
  expect(body.details?.reason).toBe("credential_inactive");
  expect(safeFetch).not.toHaveBeenCalled();
});

test("stalled endpoint prevalidation returns 504 before admission", async () => {
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
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
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
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("caller-aborted inbound JSON read returns 504 before admission", async () => {
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
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
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
  expect(admitFlatGenerativeOperation.mock.calls[0]?.[0].cost).toEqual({
    baseTotalCost: 0.05,
    platformMarkup: 0.015,
    totalCost: 0.065,
  });
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
  expect(settleUnknown).toHaveBeenCalledTimes(1);
});

test("malformed UTF-8 request body returns 400 before admission (#24768)", async () => {
  const malformed = new Uint8Array([
    0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
  ]);
  const res = await app.request("/test-mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: malformed as unknown as string,
  });
  expect(res.status).toBe(400);
  expect((await res.json()) as { error: string }).toEqual({
    error: "MCP request body is not valid UTF-8",
  });
  expect(admitFlatGenerativeOperation).not.toHaveBeenCalled();
  expect(settle).not.toHaveBeenCalled();
  expect(safeFetch).not.toHaveBeenCalled();
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});

test("malformed UTF-8 upstream response returns 502, refunds exact receipt, and skips usage (#24768)", async () => {
  const malformed = new Uint8Array([
    0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
  ]);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(malformed);
      controller.close();
    },
  });
  safeFetch.mockResolvedValue(
    new Response(stream as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  const res = await post();
  expect(res.status).toBe(502);
  expect((await res.json()) as { error: string }).toEqual({
    error: "MCP response is not valid UTF-8",
  });
  expect(settleUnknown).toHaveBeenCalledTimes(1);
  expect(recordUsageWithoutDeduction).not.toHaveBeenCalled();
});
