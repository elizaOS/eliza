/**
 * Exercises the real proxy engine, RPC handler, and shipped memory cache backend
 * against local HTTP. Auth, price, credit reservation, and usage are test seams;
 * no external provider or financial operation is used.
 */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import * as authActual from "../../auth";
import * as cacheActual from "../../cache/client";
import * as creditsActual from "../credits";
import * as usageActual from "../usage";

const realCache = { ...cacheActual };
const isolatedCache = new cacheActual.CacheClient();
mock.module("../../cache/client", () => ({ ...realCache, cache: isolatedCache }));

const realAuth = { ...authActual };
const realCredits = { ...creditsActual };
const realUsage = { ...usageActual };

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
  assertCreditRefundWithinReservation: realCredits.assertCreditRefundWithinReservation,
  assertValidCreditSettlementCosts: realCredits.assertValidCreditSettlementCosts,
  creditsService: { ...realCredits.creditsService, reserve },
}));

mock.module("../usage", () => ({
  ...realUsage,
  usageService: { ...realUsage.usageService, create: usageCreate },
}));

const { createHandler } = await import("./engine");
const { rpcConfigForChain, rpcHandlerForChain } = await import("./services/rpc");
const originalFetch = globalThis.fetch;
const envNames = ["CACHE_BACKEND", "ALCHEMY_API_KEY", "ALCHEMY_MAX_RETRIES"] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));

beforeEach(() => {
  process.env.CACHE_BACKEND = "memory";
  process.env.ALCHEMY_API_KEY = "local-cache-fixture";
  process.env.ALCHEMY_MAX_RETRIES = "1";
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
  mock.module("../../cache/client", () => realCache);
  mock.module("../../auth", () => realAuth);
  mock.module("../credits", () => realCredits);
  mock.module("../usage", () => realUsage);
  for (const key of envNames) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function request(method: string, id: string): Request {
  return new Request("https://local-fixture.invalid/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Cache-Control": "max-age=30" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params: [] }),
  });
}

for (const method of [
  "eth_newFilter",
  "eth_newBlockFilter",
  "eth_newPendingTransactionFilter",
  "eth_getFilterChanges",
  "eth_uninstallFilter",
  "eth_subscribe",
  "eth_unsubscribe",
  "eth_sendRawTransaction",
  "eth_getBalance",
]) {
  test(`${method} preserves its provider execution contract when cache is requested`, async () => {
    let executions = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        executions += 1;
        const body = await req.json();
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: `provider-result-${executions}`,
        });
      },
    });
    try {
      globalThis.fetch = (_input, init) => originalFetch(server.url, init);
      const config = rpcConfigForChain("ethereum");
      const handler = createHandler(
        { ...config, auth: "session", rateLimit: undefined, getCost: async () => 1 },
        rpcHandlerForChain("ethereum"),
      );
      const id = crypto.randomUUID();
      const first = await handler(request(method, id));
      const second = await handler(request(method, id));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      const firstPayload = await first.json();
      const secondPayload = await second.json();
      expect(firstPayload.result).toBe("provider-result-1");
      if (method === "eth_getBalance") {
        expect(executions).toBe(1);
        expect(secondPayload.result).toBe("provider-result-1");
        expect(second.headers.get("X-Cache")).toBe("HIT");
      } else {
        expect(executions).toBe(2);
        expect(secondPayload.result).toBe("provider-result-2");
        expect(second.headers.get("X-Cache")).not.toBe("HIT");
      }
    } finally {
      server.stop(true);
    }
  });
}
