/**
 * Error-policy proof for the Birdeye market-data proxy handler (#13415).
 *
 * Pins that a designed-invalid / not-configured result stays visually distinct
 * from an internal failure, and that an internal failure PROPAGATES through the
 * J1 route boundary (`failureResponse`) as a structured `{ success: false }`
 * rather than being swallowed into a fabricated 2xx/empty body. Combined
 * admission is injected; generic auth must not run.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Context } from "hono";
import type { AppEnv } from "../../../types/cloud-worker-env";
import * as cacheActual from "../../cache/client";
import * as creditsActual from "../credits";
import * as usageActual from "../usage";
import type { ProxyCombinedAdmission } from "./engine";
import * as pricingActual from "./pricing";

const realCredits = { ...creditsActual };
const realPricing = { ...pricingActual };
const realUsage = { ...usageActual };
const realCache = { ...cacheActual };

const ORG_ID = "00000000-0000-4000-8000-0000000000aa";
const USER_ID = "00000000-0000-4000-8000-0000000000bb";
const COST = 0.0003;

const reconcile = mock<(actualCost: number) => Promise<void>>();
const reserve = mock<(args: unknown) => Promise<{ reconcile: typeof reconcile }>>();
const getServiceMethodCost = mock<(service: string, method: string) => Promise<number>>();
const resolveCombinedAdmission = mock<() => Promise<ProxyCombinedAdmission>>();

mock.module("../credits", () => ({
  ...realCredits,
  creditsService: { ...realCredits.creditsService, reserve },
}));
mock.module("./pricing", () => ({ ...realPricing, getServiceMethodCost }));
mock.module("../usage", () => ({
  ...realUsage,
  usageService: { ...realUsage.usageService, create: mock(async () => undefined) },
}));
mock.module("../../cache/client", () => ({
  ...realCache,
  cache: { get: async () => null, set: async () => {} },
}));

const { InsufficientCreditsError } = creditsActual;
const { handleBirdeyeMarketDataProxyGet } = await import("./birdeye-handler");

const originalFetch = globalThis.fetch;

function stubAdmission(): ProxyCombinedAdmission {
  return {
    auth: { user: { id: USER_ID, organization_id: ORG_ID } },
    requestId: "birdeye-test",
  };
}

function makeContext(path: string, env: Record<string, unknown> = {}): Context<AppEnv> {
  const url = `https://api.elizacloud.ai/proxy/${path}`;
  const raw = new Request(url, { method: "GET" });
  return {
    env,
    req: {
      param: (key: string) => (key === "*" ? path : undefined),
      url,
      header: (_name: string) => undefined,
      raw,
    },
    json: (body: unknown, status?: number) => Response.json(body, { status: status ?? 200 }),
  } as unknown as Context<AppEnv>;
}

function mockUpstream(status: number, body = "{}") {
  globalThis.fetch = mock(
    async () => new Response(body, { status, headers: { "Content-Type": "application/json" } }),
  ) as unknown as typeof fetch;
}

beforeEach(() => {
  reconcile.mockReset();
  reserve.mockReset();
  getServiceMethodCost.mockReset();
  resolveCombinedAdmission.mockReset();
  reconcile.mockResolvedValue(undefined);
  reserve.mockResolvedValue({ reconcile });
  getServiceMethodCost.mockResolvedValue(COST);
  resolveCombinedAdmission.mockResolvedValue(stubAdmission());
  mockUpstream(200, '{"data":{"value":1}}');
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  mock.module("../credits", () => realCredits);
  mock.module("./pricing", () => realPricing);
  mock.module("../usage", () => realUsage);
  mock.module("../../cache/client", () => realCache);
});

describe("birdeye proxy — designed-invalid results stay distinct from failures", () => {
  test("unpriced path is a designed 400 reject, not a boundary failure", async () => {
    const res = await handleBirdeyeMarketDataProxyGet(
      makeContext("defi/not_a_real_path", { BIRDEYE_API_KEY: "key" }),
      resolveCombinedAdmission,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; supportedPaths: string[] };
    expect(body.error).toContain("Unpriced Birdeye proxy path");
    expect(Array.isArray(body.supportedPaths)).toBe(true);
    expect(resolveCombinedAdmission).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  test("missing BIRDEYE_API_KEY is a designed 503 not-configured, no debit", async () => {
    const res = await handleBirdeyeMarketDataProxyGet(
      makeContext("defi/price", {}),
      resolveCombinedAdmission,
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("server misconfigured");
    expect(resolveCombinedAdmission).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });
});

describe("birdeye proxy — internal failures propagate through the J1 boundary", () => {
  test("a pricing-store failure surfaces as a structured 5xx, never a fake 2xx", async () => {
    getServiceMethodCost.mockRejectedValue(new Error("pricing store unavailable"));

    const res = await handleBirdeyeMarketDataProxyGet(
      makeContext("defi/price", { BIRDEYE_API_KEY: "key" }),
      resolveCombinedAdmission,
    );

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Upstream service error");
    expect(reserve).not.toHaveBeenCalled();
  });

  test("an auth failure is translated, not swallowed into a healthy response", async () => {
    resolveCombinedAdmission.mockRejectedValue(new Error("token verification failed"));

    const res = await handleBirdeyeMarketDataProxyGet(
      makeContext("defi/price", { BIRDEYE_API_KEY: "key" }),
      resolveCombinedAdmission,
    );

    expect(res.ok).toBe(false);
    const body = (await res.json()) as { success: boolean };
    expect(body.success).toBe(false);
    expect(reserve).not.toHaveBeenCalled();
  });
});

describe("birdeye proxy — money-path debit failures stay distinct", () => {
  test("designed insufficient balance returns 402", async () => {
    reserve.mockRejectedValue(new InsufficientCreditsError(COST, 0));
    const res = await handleBirdeyeMarketDataProxyGet(
      makeContext("defi/price", { BIRDEYE_API_KEY: "key" }),
      resolveCombinedAdmission,
    );
    expect(res.status).toBe(402);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Insufficient credits");
  });

  test("an internal debit failure surfaces as a structured 5xx", async () => {
    reserve.mockRejectedValue(new Error("credits ledger write failed"));
    const res = await handleBirdeyeMarketDataProxyGet(
      makeContext("defi/price", { BIRDEYE_API_KEY: "key" }),
      resolveCombinedAdmission,
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Upstream service error");
  });
});
