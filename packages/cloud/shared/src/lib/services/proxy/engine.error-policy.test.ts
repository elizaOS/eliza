/**
 * Error-policy proof for the proxy engine boundary (#13415).
 *
 * Drives the real exported `createHandler` through its outer J1 boundary and the
 * J2 handler-failure refund path, asserting that an INTERNAL failure surfaces
 * observably (a 5xx error response + a refunded reservation) and stays
 * distinguishable from DESIGNED client-error states (400 invalid body, 402
 * insufficient credits) — never a fabricated 2xx success. Credits, usage, auth,
 * and cache are the mocked boundaries; the engine's branching is the unit under
 * test.
 *
 * `mock.module` is process-global in Bun's single-process run, so the real
 * modules are restored in `afterAll`.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as authActual from "../../auth";
import * as cacheActual from "../../cache/client";
import * as creditsActual from "../credits";
import * as usageActual from "../usage";
import type { ProxyRequestBody, ServiceConfig } from "./types";

const realAuth = { ...authActual };
const realCredits = { ...creditsActual };
const realUsage = { ...usageActual };
const realCache = { ...cacheActual };

const ORG_ID = "00000000-0000-4000-8000-0000000000aa";
const USER_ID = "00000000-0000-4000-8000-0000000000bb";

const reconcile = mock<(actualCost: number) => Promise<void>>();
const reserve = mock<(args: unknown) => Promise<{ reconcile: typeof reconcile }>>();
const usageCreate = mock<(args: unknown) => Promise<void>>();

mock.module("../../auth", () => ({
  ...realAuth,
  requireAuth: async () => ({ id: USER_ID, organization_id: ORG_ID }),
}));

mock.module("../credits", () => ({
  ...realCredits,
  creditsService: { ...realCredits.creditsService, reserve },
}));

mock.module("../usage", () => ({
  ...realUsage,
  usageService: { ...realUsage.usageService, create: usageCreate },
}));

mock.module("../../cache/client", () => ({
  ...realCache,
  cache: { get: async () => null, set: async () => {} },
}));

// InsufficientCreditsError is a real export used by the engine's instanceof check.
const { InsufficientCreditsError } = creditsActual;
const { createHandler } = await import("./engine");

const originalFetch = globalThis.fetch;

function makeConfig(): ServiceConfig {
  return {
    id: "test-service",
    name: "Test Service",
    auth: "session",
    getCost: async () => 5,
  };
}

function makeRequest(body: ProxyRequestBody | string): Request {
  return new Request("https://api.elizacloud.ai/proxy/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  reconcile.mockReset();
  reserve.mockReset();
  usageCreate.mockReset();
  reconcile.mockResolvedValue(undefined);
  reserve.mockResolvedValue({ reconcile });
  usageCreate.mockResolvedValue(undefined);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../../auth", () => realAuth);
  mock.module("../credits", () => realCredits);
  mock.module("../usage", () => realUsage);
  mock.module("../../cache/client", () => realCache);
});

describe("proxy engine error-policy boundary", () => {
  test("an internal handler failure surfaces as a 5xx AND refunds the reservation (J2 + J1)", async () => {
    const handler = createHandler(makeConfig(), async () => {
      throw new Error("upstream socket exploded");
    });

    const res = await handler(makeRequest({ method: "getBalance" }));

    // Fail closed: the failure surfaces as an error response, never a fabricated 200.
    expect(res.status).toBe(502);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("Upstream service error");
    // J2: the reservation was refunded to 0 before the error propagated.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBe(0);
  });

  test("a generic internal error is NOT reclassified as a client error", async () => {
    const handler = createHandler(makeConfig(), async () => {
      throw new Error("kv store connection reset");
    });

    const res = await handler(makeRequest({ method: "getBalance" }));

    // A neutral internal error must land in the 5xx band, distinct from 400/402/504.
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.status).toBe(502);
  });

  test("a designed client error (invalid JSON) is a distinct 400 — never a 5xx or a success (J3)", async () => {
    const handler = createHandler(makeConfig(), async () => {
      throw new Error("must not run — parse fails first");
    });

    const res = await handler(makeRequest("{not valid json"));

    expect(res.status).toBe(400);
    const payload = (await res.json()) as { error: string };
    expect(payload.error).toBe("Invalid JSON");
    // Parse failed before any billing occurred — no reservation, no refund fabricated.
    expect(reserve).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  test("insufficient credits surfaces as a distinct 402, not a 5xx or a served response", async () => {
    reserve.mockRejectedValueOnce(new InsufficientCreditsError(5, 1));

    const work = mock(async () => {
      throw new Error("must not run — reserve fails first");
    });
    const handler = createHandler(makeConfig(), work);

    const res = await handler(makeRequest({ method: "getBalance" }));

    expect(res.status).toBe(402);
    const payload = (await res.json()) as { error: string; required: number; available: number };
    expect(payload.error).toBe("Insufficient credits");
    expect(payload.required).toBe(5);
    expect(payload.available).toBe(1);
    // The billing failure short-circuits before the handler runs; nothing is fabricated.
    expect(work).not.toHaveBeenCalled();
  });

  test("a successful handler result is passed through unchanged (the healthy path stays distinct)", async () => {
    const handler = createHandler(makeConfig(), async () => ({
      response: Response.json({ ok: true }, { status: 200 }),
    }));

    const res = await handler(makeRequest({ method: "getBalance" }));

    expect(res.status).toBe(200);
    // Healthy path reconciles the reserved cost once (not the refund path).
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile.mock.calls[0]?.[0]).toBe(5);
  });
});
