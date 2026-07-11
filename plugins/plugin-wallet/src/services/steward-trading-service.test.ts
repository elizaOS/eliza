/**
 * Contract tests for the Steward trading HTTP client. The fixtures preserve the
 * real `/v1/trade` route envelopes while avoiding live credentials or venue
 * funds; these tests pin the Eliza-side retry, outcome, and method boundary.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => {
  return await import("../__tests__/core-vitest-mock.js");
});

import { stewardFixtures } from "./__fixtures__/steward-trade-responses.js";
import {
  STEWARD_TRADING_SERVICE_TYPE,
  StewardTradingService,
} from "./steward-trading-service.js";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function runtime(
  settings: Record<string, string | undefined> = {},
): IAgentRuntime {
  return {
    getSetting: (key: string) => settings[key],
    logger: {
      warn: vi.fn(),
      log: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as IAgentRuntime;
}

function configuredService(
  fetchMock: typeof fetch,
  maxRetries = 3,
  apiUrl = "https://steward.local",
) {
  return new StewardTradingService(
    runtime({
      STEWARD_API_URL: apiUrl,
      STEWARD_AGENT_ID: "agent-fixture",
      STEWARD_AGENT_TOKEN: "token-fixture",
    }),
    {
      fetch: fetchMock,
      sleep: async () => undefined,
      maxRetries,
    },
  );
}

describe("StewardTradingService", () => {
  it("registers under the intended service type and reports configured capability", () => {
    const service = new StewardTradingService(
      runtime({
        STEWARD_API_URL: "https://steward.local",
        STEWARD_AGENT_ID: "agent-fixture",
        STEWARD_AGENT_TOKEN: "token-fixture",
      }),
    );

    expect(StewardTradingService.serviceType).toBe(
      STEWARD_TRADING_SERVICE_TYPE,
    );
    expect(service.capability()).toMatchObject({
      kind: "steward-self",
      canTrade: true,
      agentId: "agent-fixture",
      apiUrl: "https://steward.local",
    });
  });

  it("allows bracketed IPv6 loopback Steward sidecar URLs", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, stewardFixtures.tokenStatusObserved),
    );
    const service = configuredService(
      fetchMock as unknown as typeof fetch,
      3,
      "http://[::1]:8787",
    );

    expect(service.capability()).toMatchObject({
      kind: "steward-self",
      canTrade: true,
      agentId: "agent-fixture",
      apiUrl: "http://[::1]:8787",
    });

    await service.tokenStatus();

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "http://[::1]:8787/v1/trade/token-status?agentId=agent-fixture",
    );
  });

  it("sends tenant API key alongside the agent bearer when both are configured", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, stewardFixtures.tokenStatusObserved),
    );
    const service = new StewardTradingService(
      runtime({
        STEWARD_API_URL: "https://steward.local",
        STEWARD_AGENT_ID: "agent-fixture",
        STEWARD_AGENT_TOKEN: "token-fixture",
        STEWARD_API_KEY: "tenant-key-fixture",
        STEWARD_TENANT_ID: "tenant-fixture",
      }),
      {
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => undefined,
      },
    );

    await service.tokenStatus();

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<
      string,
      string
    >;
    expect(headers.Authorization).toBe("Bearer token-fixture");
    expect(headers["X-Steward-Key"]).toBe("tenant-key-fixture");
    expect(headers["X-Steward-Tenant"]).toBe("tenant-fixture");
  });

  it("opens sessions through the versioned route with Steward request names", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, stewardFixtures.openHyperliquidSession),
    );
    const service = configuredService(fetchMock as unknown as typeof fetch);

    const result = await service.openSession({
      venue: "hyperliquid",
      dailyCapUsd: 300,
      perOrderCapUsd: 25,
      leverageCap: 3,
      allowedAssets: ["BTC", "ETH"],
      ttlSeconds: 3600,
    });

    expect(result).toEqual({
      ok: true,
      data: {
        sessionId: "sess_hl_fixture",
        expiresAt: "2026-07-10T01:00:00.000Z",
      },
      audit: { sessionId: "sess_hl_fixture" },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://steward.local/v1/trade/sessions",
    );
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request).toMatchObject({
      agentId: "agent-fixture",
      venue: "hyperliquid",
      dailyCap: 300,
      perOrderCap: 25,
      leverageCap: 3,
      ttlSeconds: 3600,
    });
    expect(request.allowedAssets).toEqual(["BTC", "ETH"]);
  });

  it("uses only versioned trade routes for session lifecycle and token status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.tokenStatusObserved),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.openHyperliquidSession),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { ok: true, data: { revoked: true } }),
      );
    const service = configuredService(fetchMock as unknown as typeof fetch);

    await service.tokenStatus();
    await service.getSession("sess_hl_fixture");
    await service.revokeSession("sess_hl_fixture");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://steward.local/v1/trade/token-status?agentId=agent-fixture",
      "https://steward.local/v1/trade/sessions/sess_hl_fixture",
      "https://steward.local/v1/trade/sessions/sess_hl_fixture/revoke",
    ]);
  });

  it("requires caller-supplied idempotency keys for submitted orders", async () => {
    const fetchMock = vi.fn();
    const service = configuredService(fetchMock as unknown as typeof fetch);

    const result = await service.submitOrder({
      venue: "hyperliquid",
      sessionId: "sess_hl_fixture",
      coin: "BTC",
      side: "buy",
      size: 0.01,
    });

    expect(result).toMatchObject({
      ok: false,
      outcome: "not_attempted",
      error: "INVALID_PARAMS",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits Hyperliquid orders with one idempotency key reused across retries", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(429, stewardFixtures.rateLimited, { "Retry-After": "0" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(503, { ok: false, error: "transient upstream failure" }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.hyperliquidOrderAccepted),
      );
    const service = configuredService(fetchMock as unknown as typeof fetch);

    const result = await service.submitOrder({
      venue: "hyperliquid",
      sessionId: "sess_hl_fixture",
      coin: "BTC",
      side: "buy",
      size: 0.01,
      limitPx: 61_000,
      leverage: 2,
      tif: "Ioc",
      idempotencyKey: "idem-fixture",
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        venue: "hyperliquid",
        orderId: "hl_order_fixture",
        status: "submitted",
        idempotencyKey: "idem-fixture",
      },
      audit: {
        sessionId: "sess_hl_fixture",
        idempotencyKey: "idem-fixture",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      const body = JSON.parse(String(call[1]?.body));
      expect(call[0]).toBe("https://steward.local/v1/trade/hyperliquid/order");
      expect(headers["Idempotency-Key"]).toBe("idem-fixture");
      expect(body.idempotencyKey).toBe("idem-fixture");
    }
  });

  it("does not retry status-unknown submit responses", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(502, stewardFixtures.unknownSubmit),
    );
    const service = configuredService(fetchMock as unknown as typeof fetch);

    const result = await service.submitOrder({
      venue: "polymarket",
      sessionId: "sess_pm_fixture",
      tokenId: "123456789",
      side: "buy",
      amount: "5",
      price: "0.42",
      idempotencyKey: "idem-fixture",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      ok: false,
      outcome: "unknown",
      error: "TIMEOUT",
      retryable: false,
    });
  });

  it("reports exhausted 5xx retries as an unknown submission", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(503, { ok: false, error: "transient upstream failure" }),
    );
    const service = configuredService(fetchMock as unknown as typeof fetch);

    const result = await service.submitOrder({
      venue: "hyperliquid",
      sessionId: "sess_hl_fixture",
      coin: "BTC",
      side: "buy",
      size: 0.01,
      idempotencyKey: "idem-fixture",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      const body = JSON.parse(String(call[1]?.body));
      expect(headers["Idempotency-Key"]).toBe("idem-fixture");
      expect(body.idempotencyKey).toBe("idem-fixture");
    }
    expect(result).toMatchObject({
      ok: false,
      outcome: "unknown",
      error: "TIMEOUT",
      retryable: false,
    });
  });

  it("reports exhausted transport retries as unknown and preserves the idempotency key", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("socket closed after write");
    });
    const service = configuredService(fetchMock as unknown as typeof fetch);

    const result = await service.submitOrder({
      venue: "hyperliquid",
      sessionId: "sess_hl_fixture",
      coin: "BTC",
      side: "buy",
      size: 0.01,
      idempotencyKey: "idem-fixture",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      const headers = call[1]?.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("idem-fixture");
    }
    expect(result).toMatchObject({
      ok: false,
      outcome: "unknown",
      error: "TIMEOUT",
      retryable: false,
    });
  });

  it("does not translate missing configuration into a retryable outage", async () => {
    const service = new StewardTradingService(runtime(), {
      fetch: vi.fn() as unknown as typeof fetch,
    });

    await expect(
      service.submitOrder({
        venue: "hyperliquid",
        sessionId: "sess_hl_fixture",
        coin: "BTC",
        side: "buy",
        size: 0.01,
        idempotencyKey: "idem-fixture",
      }),
    ).rejects.toThrow("Steward trading is not configured");
  });

  it("maps critical Steward failures into outcome classes and retry flags", async () => {
    const cases = [
      {
        status: 400,
        body: stewardFixtures.policyViolation,
        expected: {
          outcome: "policy_denied",
          error: "POLICY_BLOCKED",
          retryable: false,
          policy: { reason: "market-not-allowed" },
        },
      },
      {
        status: 403,
        body: stewardFixtures.missingAgentPolicy,
        expected: {
          outcome: "policy_denied",
          error: "POLICY_REQUIRES_APPROVAL",
          retryable: false,
          policy: { reason: "policy-missing" },
        },
      },
      {
        status: 403,
        body: { ok: false, error: "Active Hyperliquid session required" },
        expected: {
          outcome: "policy_denied",
          error: "SESSION_REQUIRED",
          retryable: false,
        },
      },
      {
        status: 403,
        body: { ok: false, error: "Agent JWT required for trading" },
        expected: {
          outcome: "not_attempted",
          error: "PROVIDER_AUTH_MISSING",
          retryable: false,
        },
      },
      {
        status: 401,
        body: { ok: false, error: "expired bearer credential" },
        expected: {
          outcome: "not_attempted",
          error: "PROVIDER_AUTH_MISSING",
          retryable: false,
        },
      },
      {
        status: 409,
        body: stewardFixtures.idempotencyConflict,
        expected: {
          outcome: "not_attempted",
          error: "IDEMPOTENCY_CONFLICT",
          retryable: false,
        },
      },
      {
        status: 429,
        body: stewardFixtures.rateLimited,
        expected: {
          outcome: "not_attempted",
          error: "RATE_LIMITED",
          retryable: true,
        },
      },
      {
        status: 503,
        body: { ok: false, error: "transient upstream failure" },
        expected: {
          outcome: "unknown",
          error: "TIMEOUT",
          retryable: false,
        },
      },
      {
        status: 404,
        body: { ok: false, error: "missing route" },
        expected: {
          outcome: "not_attempted",
          error: "ROUTE_NOT_FOUND",
          retryable: false,
        },
      },
    ] as const;

    for (const c of cases) {
      const fetchMock = vi.fn(async () =>
        jsonResponse(c.status, c.body, { "Retry-After": "0" }),
      );
      const service = configuredService(
        fetchMock as unknown as typeof fetch,
        1,
      );

      const result = await service.submitOrder({
        venue: "polymarket",
        sessionId: "sess_pm_fixture",
        tokenId: "123456789",
        side: "buy",
        amount: "5",
        price: "0.42",
        idempotencyKey: "idem-fixture",
      });

      expect(result).toMatchObject({ ok: false, ...c.expected });
    }
  });

  it("keeps venue instrument token rejections out of credential handling", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(400, { ok: false, error: "token not supported" }),
    );
    const service = configuredService(fetchMock as unknown as typeof fetch, 1);

    const result = await service.submitOrder({
      venue: "polymarket",
      sessionId: "sess_pm_fixture",
      tokenId: "123456789",
      side: "buy",
      amount: "5",
      price: "0.42",
      idempotencyKey: "idem-fixture",
    });

    expect(result).toMatchObject({
      ok: false,
      outcome: "rejected",
      error: "PROVIDER_REJECTED",
      detail: "token not supported",
      retryable: false,
    });
  });

  it("resolves an active governed account from token and session state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.tokenStatusObserved),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.activeHyperliquidSession),
      );
    const service = new StewardTradingService(
      runtime({
        STEWARD_API_URL: "https://steward.local",
        STEWARD_AGENT_ID: "agent-fixture",
        STEWARD_AGENT_TOKEN: "token-fixture",
        STEWARD_HYPERLIQUID_TRADE_SESSION_ID: "sess_hl_fixture",
      }),
      { fetch: fetchMock as unknown as typeof fetch },
    );

    await expect(service.resolveAccount("hyperliquid")).resolves.toEqual({
      ok: true,
      data: {
        venue: "hyperliquid",
        accountId: "wallet_fixture",
        agentId: "agent-fixture",
        walletAddress: undefined,
        walletId: "wallet_fixture",
        status: "active",
      },
      audit: { sessionId: "sess_hl_fixture" },
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://steward.local/v1/trade/token-status?agentId=agent-fixture",
      "https://steward.local/v1/trade/sessions/sess_hl_fixture",
    ]);
  });

  it("preserves Steward outages while resolving governed accounts", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(503, { ok: false, error: "transient upstream failure" }),
    );
    const service = new StewardTradingService(
      runtime({
        STEWARD_API_URL: "https://steward.local",
        STEWARD_AGENT_ID: "agent-fixture",
        STEWARD_AGENT_TOKEN: "token-fixture",
        STEWARD_HYPERLIQUID_TRADE_SESSION_ID: "sess_hl_fixture",
      }),
      { fetch: fetchMock as unknown as typeof fetch },
    );

    await expect(service.resolveAccount("hyperliquid")).resolves.toMatchObject({
      ok: false,
      outcome: "not_attempted",
      error: "STEWARD_UNAVAILABLE",
      retryable: true,
    });
  });

  it("exposes exact neutral methods and fail-closed unavailable routes", async () => {
    const service = configuredService(vi.fn() as unknown as typeof fetch);

    expect(typeof service.resolveAccount).toBe("function");
    expect(typeof service.listOrders).toBe("function");
    expect(typeof service.cancelOrder).toBe("function");
    expect(typeof service.listPositions).toBe("function");
    expect("listOpenOrders" in service).toBe(false);

    await expect(service.resolveAccount("hyperliquid")).resolves.toMatchObject({
      ok: false,
      outcome: "policy_denied",
      error: "SESSION_REQUIRED",
      retryable: false,
    });
    await expect(service.listOrders("polymarket")).resolves.toMatchObject({
      ok: false,
      outcome: "not_attempted",
      error: "ROUTE_NOT_FOUND",
      retryable: false,
    });
    await expect(
      service.cancelOrder({ venue: "polymarket", orderId: "order-fixture" }),
    ).resolves.toMatchObject({
      ok: false,
      outcome: "not_attempted",
      error: "ROUTE_NOT_FOUND",
      retryable: false,
    });
    await expect(service.listPositions("hyperliquid")).resolves.toMatchObject({
      ok: false,
      outcome: "not_attempted",
      error: "ROUTE_NOT_FOUND",
      retryable: false,
    });
  });
});
