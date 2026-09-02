/**
 * Exercises paid proxy admission through mounted Hono middleware and real
 * route adapters while replacing only remote cache, Durable Object, and
 * upstream-provider boundaries with deterministic fakes.
 */

import { beforeEach, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import type { AppEnv } from "@/types/cloud-worker-env";

const globalSessionReads = mock();
const standingReads: Request[] = [];
const admissionCalls: Array<Record<string, unknown>> = [];
const providerDispatch = mock(async () => ({
  response: Response.json({ ok: true }),
}));
const genericReserve = mock(async () => {
  throw new Error("generic reserve must not run");
});
const orgRateLimit = mock(async () => null);
let authOutcome: "authorized" | "denied" | "warming" = "authorized";
let includeStrongCredential = true;

const snapshot = {
  balance: { balanceUsd: 10, balanceAt: Date.now(), balanceRevision: "19" },
  rateLimits: {
    completionsRpm: 100,
    embeddingsRpm: 100,
    standardRpm: 100,
    strictRpm: 100,
  },
};

mock.module("@/lib/auth/workers-hono-auth", () => ({
  getCurrentUser: globalSessionReads,
  requireUserOrApiKeyWithOrg: mock(async () => ({
    id: "user-1",
    organization_id: "org-1",
  })),
}));
const rawAuth = mock(async (request: Request) => ({
  user: { id: "user-1", organization_id: "org-1" },
  ...(request.headers.has("x-api-key") ||
  request.headers.get("authorization")?.startsWith("Bearer eliza_")
    ? { apiKey: { id: "key-1" } }
    : {}),
}));
mock.module("@/lib/auth", () => ({
  requireAuth: rawAuth,
  requireAuthWithOrg: rawAuth,
  requireAuthOrApiKey: rawAuth,
  requireAuthOrApiKeyWithOrg: rawAuth,
}));
mock.module("@/lib/services/inference-auth-context", () => ({
  observeInferenceApiKeyUsage: () => undefined,
  resolveInferenceAuthContext: mock(
    async (
      request: Request,
      _options: { deferStrongCredentialCheck?: boolean },
    ) => {
      standingReads.push(request);
      if (authOutcome === "warming") return { kind: "warming" };
      if (authOutcome === "denied") {
        return {
          kind: "rejected",
          status: 403,
          reason: "organization_inactive",
        };
      }
      const authorization = request.headers.get("authorization") ?? "";
      const apiKey =
        request.headers.get("x-api-key") ??
        (authorization.startsWith("Bearer eliza_")
          ? authorization.slice(7)
          : null);
      const apiKeyId = apiKey ? "key-1" : null;
      return {
        kind: "authorized",
        source: "cache",
        ctx: {
          v: 1,
          cachedAt: Date.now(),
          userId: "user-1",
          orgId: "org-1",
          apiKeyId,
          admission: snapshot,
        },
        ...(includeStrongCredential
          ? {
              credential: apiKeyId
                ? {
                    kind: "api_key",
                    credentialId: apiKeyId,
                    userId: "user-1",
                  }
                : {
                    kind: "steward_session",
                    userId: "user-1",
                    stewardUserId: "steward-1",
                    issuedAt: 1,
                  },
            }
          : {}),
      };
    },
  ),
}));
mock.module("@/lib/middleware/rate-limit", () => ({
  enforceOrgRateLimit: orgRateLimit,
  withRateLimit: (handler: unknown) => handler,
}));
mock.module("@/lib/services/inference-admission-snapshot", () => ({
  inferenceRateLimitConfig: () => ({ windowMs: 60_000, maxRequests: 100 }),
}));
mock.module("@/lib/services/organization-inference-admission", () => ({
  admitOrganizationInference: mock(async (params: Record<string, unknown>) => {
    admissionCalls.push(params);
    return {
      mode: "durable_object_debit",
      markProviderDispatched: async () => undefined,
      settle: async () => null,
      settleUnknown: async () => null,
    };
  }),
}));
mock.module("@/lib/services/credits", () => ({
  creditsService: { reserve: genericReserve },
  InsufficientCreditsError: class InsufficientCreditsError extends Error {},
}));
mock.module("@/lib/services/usage", () => ({
  usageService: { create: async () => undefined },
}));
mock.module("@/lib/cache/client", () => ({
  cache: { get: async () => null, set: async () => undefined },
}));
mock.module("@/lib/services/proxy/pricing", () => ({
  calculateBatchCost: async () => 0.01,
  getServiceMethodCost: async () => 0.01,
  PricingNotFoundError: class PricingNotFoundError extends Error {},
}));
mock.module("@/lib/services/proxy/services/market-data", () => ({
  marketDataConfig: {
    id: "market-data",
    name: "Market data",
    auth: "apiKeyWithOrg",
    getCost: async () => 0.01,
  },
  marketDataHandler: providerDispatch,
}));
mock.module("@/lib/services/proxy/services/chain-data", () => ({
  chainDataConfig: {
    id: "chain-data",
    name: "Chain data",
    auth: "apiKeyWithOrg",
    getCost: async () => 0.01,
  },
  chainDataHandler: providerDispatch,
}));
mock.module("@/lib/services/proxy/services/rpc", () => ({
  ALCHEMY_SLUGS: { ethereum: "eth-mainnet" },
  SUPPORTED_RPC_CHAINS: new Set(["ethereum"]),
  isValidRpcChain: (chain: string) => chain === "ethereum",
  rpcConfigForChain: () => ({
    id: "evm-rpc",
    name: "EVM RPC",
    auth: "apiKeyWithOrg",
    getCost: async () => 0.01,
  }),
  rpcHandlerForChain: () => providerDispatch,
}));
mock.module("@/lib/services/proxy/services/solana-rpc", () => ({
  solanaRpcConfig: {
    id: "solana-rpc",
    name: "Solana RPC",
    auth: "apiKeyWithOrg",
    getCost: async () => 0.01,
  },
  solanaRpcHandler: providerDispatch,
}));

const [
  { authMiddleware },
  { default: marketPriceRoute },
  { default: canonicalRpcRoute },
  { default: legacyEvmRpcRoute },
  { default: legacySolanaRpcRoute },
  { default: solanaRpcRoute },
  { default: birdeyeRoute },
  { default: solanaAssetsRoute },
  { default: solanaTokenAccountsRoute },
  { default: solanaTransactionsRoute },
  { default: chainNftsRoute },
  { default: chainTokensRoute },
  { default: chainTransfersRoute },
  { default: marketCandlesRoute },
  { default: marketPortfolioRoute },
  { default: marketTokenRoute },
  { default: marketTradesRoute },
] = await Promise.all([
  import("./middleware/auth"),
  import("../v1/market/price/[chain]/[address]/route"),
  import("../v1/rpc/[chain]/route"),
  import("../v1/proxy/evm-rpc/[chain]/route"),
  import("../v1/proxy/solana-rpc/route"),
  import("../v1/solana/rpc/route"),
  import("../v1/apis/birdeye/[...path]/route"),
  import("../v1/solana/assets/[address]/route"),
  import("../v1/solana/token-accounts/[address]/route"),
  import("../v1/solana/transactions/[address]/route"),
  import("../v1/chain/nfts/[chain]/[address]/route"),
  import("../v1/chain/tokens/[chain]/[address]/route"),
  import("../v1/chain/transfers/[chain]/[address]/route"),
  import("../v1/market/candles/[chain]/[address]/route"),
  import("../v1/market/portfolio/[chain]/[address]/route"),
  import("../v1/market/token/[chain]/[address]/route"),
  import("../v1/market/trades/[chain]/[address]/route"),
]);

function mountedApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", crypto.randomUUID());
    c.set("traceId", crypto.randomUUID());
    c.set("user", undefined);
    await next();
  });
  app.use("*", authMiddleware);
  app.route("/api/v1/market/price/:chain/:address", marketPriceRoute);
  app.route("/api/v1/rpc/:chain", canonicalRpcRoute);
  app.route("/api/v1/proxy/evm-rpc/:chain", legacyEvmRpcRoute);
  app.route("/api/v1/proxy/solana-rpc", legacySolanaRpcRoute);
  app.route("/api/v1/solana/rpc", solanaRpcRoute);
  app.route("/api/v1/apis/birdeye", birdeyeRoute);
  app.route("/api/v1/solana/assets/:address", solanaAssetsRoute);
  app.route("/api/v1/solana/token-accounts/:address", solanaTokenAccountsRoute);
  app.route("/api/v1/solana/transactions/:address", solanaTransactionsRoute);
  app.route("/api/v1/chain/nfts/:chain/:address", chainNftsRoute);
  app.route("/api/v1/chain/tokens/:chain/:address", chainTokensRoute);
  app.route("/api/v1/chain/transfers/:chain/:address", chainTransfersRoute);
  app.route("/api/v1/market/candles/:chain/:address", marketCandlesRoute);
  app.route("/api/v1/market/portfolio/:chain/:address", marketPortfolioRoute);
  app.route("/api/v1/market/token/:chain/:address", marketTokenRoute);
  app.route("/api/v1/market/trades/:chain/:address", marketTradesRoute);
  return app;
}

const executionCtx = {
  waitUntil(promise: Promise<unknown>) {
    void promise.catch(() => undefined);
  },
  passThroughOnException() {},
  props: {},
};

function authHeaders(kind: "session" | "api_key"): HeadersInit {
  return kind === "session"
    ? { cookie: "steward_access=session.jwt.token" }
    : { "x-api-key": "eliza_test_key" };
}

beforeEach(() => {
  globalSessionReads.mockClear();
  standingReads.length = 0;
  admissionCalls.length = 0;
  providerDispatch.mockClear();
  genericReserve.mockClear();
  orgRateLimit.mockClear();
  rawAuth.mockClear();
  authOutcome = "authorized";
  includeStrongCredential = true;
});

for (const kind of ["session", "api_key"] as const) {
  test(`${kind} performs one standing read through executeWithBody, canonical RPC, and Birdeye`, async () => {
    const app = mountedApp();
    const cases = [
      new Request(
        "https://api.test/api/v1/market/price/ethereum/0x0000000000000000000000000000000000000001",
        { headers: authHeaders(kind) },
      ),
      new Request("https://api.test/api/v1/rpc/ethereum", {
        method: "POST",
        headers: { ...authHeaders(kind), "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
      }),
      new Request("https://api.test/api/v1/apis/birdeye/defi/price", {
        headers: authHeaders(kind),
      }),
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      Response.json({ data: { value: 1 } }),
    ) as unknown as typeof fetch;
    try {
      for (const request of cases) {
        const beforeReads = standingReads.length;
        const beforeAdmissions = admissionCalls.length;
        const response = await app.fetch(
          request,
          { NODE_ENV: "production", BIRDEYE_API_KEY: "provider-key" } as never,
          executionCtx as never,
        );
        expect({
          url: request.url,
          status: response.status,
          body: await response.clone().text(),
        }).toMatchObject({ status: 200 });
        expect(standingReads).toHaveLength(beforeReads + 1);
        expect(admissionCalls).toHaveLength(beforeAdmissions + 1);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(globalSessionReads).not.toHaveBeenCalled();
    expect(genericReserve).not.toHaveBeenCalled();
  });
}

test("all three query-key RPC routes resolve and dispatch with the same rewritten request", async () => {
  const app = mountedApp();
  const paths = [
    "/api/v1/proxy/evm-rpc/ethereum?api_key=eliza_query_key",
    "/api/v1/proxy/solana-rpc?api_key=eliza_query_key",
    "/api/v1/solana/rpc?api_key=eliza_query_key",
  ];

  for (const path of paths) {
    const response = await app.fetch(
      new Request(`https://api.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance" }),
      }),
      { NODE_ENV: "production" } as never,
      executionCtx as never,
    );
    expect(response.status).toBe(200);
  }

  expect(globalSessionReads).not.toHaveBeenCalled();
  expect(standingReads).toHaveLength(3);
  for (const request of standingReads) {
    expect(request.headers.get("authorization")).toBe("Bearer eliza_query_key");
  }
  expect(admissionCalls).toHaveLength(3);
  expect(providerDispatch).toHaveBeenCalledTimes(3);
});

test("every guarded route authenticates once before local validation or parsing rejects", async () => {
  const app = mountedApp();
  const invalidCases = [
    ["GET", "/api/v1/chain/nfts/unsupported/0x1"],
    ["GET", "/api/v1/chain/tokens/unsupported/0x1"],
    ["GET", "/api/v1/chain/transfers/unsupported/0x1"],
    ["GET", "/api/v1/market/candles/unsupported/0x1"],
    ["GET", "/api/v1/market/portfolio/unsupported/0x1"],
    ["GET", "/api/v1/market/price/unsupported/0x1"],
    ["GET", "/api/v1/market/token/unsupported/0x1"],
    ["GET", "/api/v1/market/trades/unsupported/0x1"],
    ["POST", "/api/v1/proxy/evm-rpc/unsupported"],
    ["POST", "/api/v1/proxy/solana-rpc"],
    ["GET", "/api/v1/solana/assets/not-a-solana-address"],
    ["POST", "/api/v1/solana/rpc"],
    ["GET", "/api/v1/solana/token-accounts/not-a-solana-address"],
    ["GET", "/api/v1/solana/transactions/not-a-solana-address"],
    ["POST", "/api/v1/rpc/unsupported"],
  ] as const;

  for (const [method, path] of invalidCases) {
    const beforeReads = standingReads.length;
    const beforeAdmissions = admissionCalls.length;
    const response = await app.fetch(
      new Request(`https://api.test${path}`, {
        method,
        headers: {
          ...authHeaders("session"),
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
        body: method === "POST" ? "{" : undefined,
      }),
      { NODE_ENV: "production" } as never,
      executionCtx as never,
    );
    expect(response.status, path).toBe(400);
    expect(standingReads, path).toHaveLength(beforeReads + 1);
    expect(admissionCalls, path).toHaveLength(beforeAdmissions);
  }

  expect(providerDispatch).not.toHaveBeenCalled();
  expect(globalSessionReads).not.toHaveBeenCalled();
});

test("HEAD self-authenticates every GET-backed guarded mount without input admission", async () => {
  const app = mountedApp();
  const malformedGetPaths = [
    "/api/v1/chain/nfts/unsupported/0x1",
    "/api/v1/chain/tokens/unsupported/0x1",
    "/api/v1/chain/transfers/unsupported/0x1",
    "/api/v1/market/candles/unsupported/0x1",
    "/api/v1/market/portfolio/unsupported/0x1",
    "/api/v1/market/price/unsupported/0x1",
    "/api/v1/market/token/unsupported/0x1",
    "/api/v1/market/trades/unsupported/0x1",
    "/api/v1/solana/assets/not-a-solana-address",
    "/api/v1/solana/token-accounts/not-a-solana-address",
    "/api/v1/solana/transactions/not-a-solana-address",
  ];

  for (const path of malformedGetPaths) {
    const beforeReads = standingReads.length;
    const beforeAdmissions = admissionCalls.length;
    const response = await app.fetch(
      new Request(`https://api.test${path}`, {
        method: "HEAD",
        headers: authHeaders("session"),
      }),
      { NODE_ENV: "production" } as never,
      executionCtx as never,
    );
    expect(response.status, path).toBe(400);
    expect(await response.text(), path).toBe("");
    expect(standingReads, path).toHaveLength(beforeReads + 1);
    expect(admissionCalls, path).toHaveLength(beforeAdmissions);
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () =>
    Response.json({ data: { value: 1 } }),
  ) as unknown as typeof fetch;
  try {
    const beforeReads = standingReads.length;
    const response = await app.fetch(
      new Request("https://api.test/api/v1/apis/birdeye/defi/price", {
        method: "HEAD",
        headers: authHeaders("session"),
      }),
      { NODE_ENV: "production", BIRDEYE_API_KEY: "provider-key" } as never,
      executionCtx as never,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(standingReads).toHaveLength(beforeReads + 1);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(globalSessionReads).not.toHaveBeenCalled();
  expect(providerDispatch).not.toHaveBeenCalled();
});

test("all three Solana reads keep typed denial status, reason, and CORS", async () => {
  authOutcome = "denied";
  const app = mountedApp();
  for (const resource of ["assets", "token-accounts", "transactions"]) {
    const response = await app.fetch(
      new Request(
        `https://api.test/api/v1/solana/${resource}/11111111111111111111111111111111`,
        { headers: authHeaders("api_key") },
      ),
      { NODE_ENV: "production" } as never,
      executionCtx as never,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toMatchObject({
      code: "access_denied",
      details: { reason: "organization_inactive" },
    });
  }
  expect(providerDispatch).not.toHaveBeenCalled();
  expect(admissionCalls).toHaveLength(0);
  expect(rawAuth).not.toHaveBeenCalled();
});

test("warming and missing Worker lifetime suppress admission, reserve, and provider dispatch", async () => {
  const app = mountedApp();
  authOutcome = "warming";
  const warming = await app.fetch(
    new Request(
      "https://api.test/api/v1/market/price/ethereum/0x0000000000000000000000000000000000000001",
      { headers: authHeaders("api_key") },
    ),
    { NODE_ENV: "production" } as never,
    executionCtx as never,
  );
  expect(warming.status).toBe(503);
  expect(warming.headers.get("Retry-After")).toBe("1");

  authOutcome = "authorized";
  const missingLifetime = await app.fetch(
    new Request(
      "https://api.test/api/v1/market/price/ethereum/0x0000000000000000000000000000000000000001",
      { headers: authHeaders("session") },
    ),
    { NODE_ENV: "production" } as never,
  );
  expect(missingLifetime.status).toBe(503);
  expect(missingLifetime.headers.get("Retry-After")).toBe("1");
  expect(admissionCalls).toHaveLength(0);
  expect(genericReserve).not.toHaveBeenCalled();
  expect(providerDispatch).not.toHaveBeenCalled();
});

test("strong revocation proof toggles without adding a second admission-gate call", async () => {
  const app = mountedApp();
  for (const enabled of [true, false]) {
    includeStrongCredential = enabled;
    const before = admissionCalls.length;
    const response = await app.fetch(
      new Request("https://api.test/api/v1/rpc/ethereum", {
        method: "POST",
        headers: {
          ...authHeaders("api_key"),
          "content-type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
      }),
      { NODE_ENV: "production" } as never,
      executionCtx as never,
    );
    expect(response.status).toBe(200);
    expect(admissionCalls).toHaveLength(before + 1);
    expect(admissionCalls.at(-1)?.credential).toBe(
      enabled ? admissionCalls.at(-1)?.credential : undefined,
    );
    if (enabled) {
      expect(admissionCalls.at(-1)?.credential).toMatchObject({
        kind: "api_key",
        credentialId: "key-1",
      });
    }
  }
  expect(standingReads).toHaveLength(2);
  expect(admissionCalls).toHaveLength(2);
  expect(providerDispatch).toHaveBeenCalledTimes(2);
});
