/**
 * Tests the native `TRADE` router through the real StewardTradingService
 * contract with injected HTTP fixtures. This keeps order confirmation,
 * idempotency handoff, and outcome rendering deterministic without live
 * Steward, Hyperliquid, Polymarket, or network access.
 */
import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

import { actionToJsonSchema } from "../../../../packages/core/src/actions/action-schema.js";
import {
  requireTradeOrderConfirmation,
  TRADE_CONFIRM_ACTION,
  tradeOrderPendingKey,
} from "../security/trade-confirmation.js";
import { stewardFixtures } from "../services/__fixtures__/steward-trade-responses.js";
import { StewardTradingService } from "../services/steward-trading-service.js";
import { tradeRouterAction } from "./trade-action.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createRuntime(fetchMock: typeof fetch): {
  readonly runtime: IAgentRuntime;
  readonly service: StewardTradingService;
  readonly cache: Map<string, unknown>;
} {
  const cache = new Map<string, unknown>();
  const getService = vi.fn(() => null);
  const getSetting = vi.fn((key: string) => {
    const settings: Record<string, string> = {
      STEWARD_API_URL: "https://steward.local",
      STEWARD_AGENT_ID: "agent-fixture",
      STEWARD_AGENT_TOKEN: "token-fixture",
      STEWARD_HYPERLIQUID_TRADE_SESSION_ID: "sess_hl_fixture",
      STEWARD_POLYMARKET_TRADE_SESSION_ID: "sess_pm_fixture",
    };
    return settings[key];
  });
  const runtime = {
    agentId: "test-agent",
    character: { name: "Test Agent", settings: {} },
    getSetting,
    getService,
    getCache: vi.fn(async <T>(key: string) => cache.get(key) as T | undefined),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    deleteCache: vi.fn(async (key: string) => {
      cache.delete(key);
      return true;
    }),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    },
  } as unknown as IAgentRuntime;
  const service = new StewardTradingService(runtime, {
    fetch: fetchMock,
    sleep: async () => undefined,
    maxRetries: 1,
  });
  getService.mockImplementation((name: string) =>
    name === StewardTradingService.serviceType ? service : null,
  );
  return { runtime, service, cache };
}

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

async function run(
  runtime: IAgentRuntime,
  text: string,
  parameters: Record<string, unknown>,
) {
  return tradeRouterAction.handler(runtime, message(text), undefined, {
    parameters,
  } as HandlerOptions);
}

const hyperliquidOrder = {
  operation: "submit_order",
  venue: "hyperliquid",
  sessionId: "sess_hl_fixture",
  coin: "BTC",
  side: "buy",
  size: 0.01,
  limitPx: 61_000,
  leverage: 2,
  tif: "Ioc",
};

describe("tradeRouterAction", () => {
  it("inspects governed account state through StewardTradingService", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.tokenStatusObserved),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.activeHyperliquidSession),
      );
    const { runtime } = createRuntime(fetchMock as unknown as typeof fetch);

    const result = await run(runtime, "inspect hyperliquid", {
      operation: "inspect_account",
      venue: "hyperliquid",
    });

    expect(result?.success).toBe(true);
    expect(result?.data?.account).toMatchObject({
      venue: "hyperliquid",
      status: "active",
      accountId: "wallet_fixture",
    });
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://steward.local/v1/trade/token-status?agentId=agent-fixture",
      "https://steward.local/v1/trade/sessions/sess_hl_fixture",
    ]);
  });

  it("is not selectable when Steward trading is unconfigured", async () => {
    const { runtime, service } = createRuntime(
      vi.fn() as unknown as typeof fetch,
    );
    service.capability = vi.fn().mockReturnValue({
      configured: false,
      canTrade: false,
      venues: ["hyperliquid", "polymarket"],
    });

    await expect(
      tradeRouterAction.validate?.(
        runtime,
        message("inspect hyperliquid"),
        undefined,
        {
          parameters: {
            operation: "inspect_account",
            venue: "hyperliquid",
          },
        } as HandlerOptions,
      ),
    ).resolves.toBe(false);
  });

  it("does not label Steward service failures as invalid parameters", async () => {
    const { runtime, service } = createRuntime(
      vi.fn() as unknown as typeof fetch,
    );
    service.resolveAccount = vi
      .fn()
      .mockRejectedValue(new Error("Steward runtime unavailable"));
    const callback = vi.fn();

    await expect(
      tradeRouterAction.handler(
        runtime,
        message("inspect hyperliquid"),
        undefined,
        {
          parameters: {
            operation: "inspect_account",
            venue: "hyperliquid",
          },
        } as HandlerOptions,
        callback,
      ),
    ).rejects.toThrow("Steward runtime unavailable");

    expect(callback).not.toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.objectContaining({ error: "INVALID_PARAMS" }),
      }),
    );
  });

  it("persists the idempotency key before confirmation and reuses it on submit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.tokenStatusObserved),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.activeHyperliquidSession),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.tokenStatusObserved),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.activeHyperliquidSession),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.hyperliquidOrderAccepted),
      );
    const { runtime, cache } = createRuntime(
      fetchMock as unknown as typeof fetch,
    );

    const pending = await run(runtime, "buy btc", hyperliquidOrder);
    expect(pending?.data?.requiresConfirmation).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const cacheKey = `confirmation:00000000-0000-0000-0000-000000000002:${TRADE_CONFIRM_ACTION}:${tradeOrderPendingKey(hyperliquidOrder)}`;
    const pendingRecord = cache.get(cacheKey) as
      | { metadata?: { idempotencyKey?: string } }
      | undefined;
    const persistedKey = pendingRecord?.metadata?.idempotencyKey;
    expect(persistedKey).toEqual(expect.any(String));

    const confirmed = await run(runtime, "yes, confirm", hyperliquidOrder);
    expect(confirmed?.success).toBe(true);
    expect(confirmed?.data?.idempotencyKey).toBe(persistedKey);
    expect(fetchMock).toHaveBeenCalledTimes(5);

    const submit = fetchMock.mock.calls[4];
    expect(submit?.[0]).toBe(
      "https://steward.local/v1/trade/hyperliquid/order",
    );
    const headers = submit?.[1]?.headers as Record<string, string>;
    const body = JSON.parse(String(submit?.[1]?.body));
    expect(headers["Idempotency-Key"]).toBe(persistedKey);
    expect(body.idempotencyKey).toBe(persistedKey);
  });

  it("generates one idempotency key for a pending logical order", async () => {
    const { runtime } = createRuntime(vi.fn() as unknown as typeof fetch);
    const keyFactory = vi.fn(() => "trade-key-1");
    const first = await requireTradeOrderConfirmation({
      runtime,
      message: message("buy btc"),
      order: hyperliquidOrder,
      prompt: "Confirm?",
      keyFactory,
    });
    const second = await requireTradeOrderConfirmation({
      runtime,
      message: message("yes"),
      order: hyperliquidOrder,
      prompt: "Confirm?",
      keyFactory,
    });

    expect(first.status).toBe("pending");
    expect(second).toEqual({
      status: "confirmed",
      metadata: {
        venue: "hyperliquid",
        sessionId: "sess_hl_fixture",
        idempotencyKey: "trade-key-1",
      },
    });
    expect(keyFactory).toHaveBeenCalledTimes(1);
  });

  it("declares every handler-supported order field in the closed tool schema", () => {
    const schema = actionToJsonSchema(tradeRouterAction);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toMatchObject({
      leverage: { type: "number" },
      reduceOnly: { type: "boolean" },
      tif: { type: "string", enum: ["Alo", "Ioc", "Gtc"] },
      tickSize: { type: "string", enum: ["0.1", "0.01", "0.001", "0.0001"] },
      negRisk: { type: "boolean" },
    });
  });

  it("does not submit when the model supplies confirmed without a user reply", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.tokenStatusObserved),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.activeHyperliquidSession),
      );
    const { runtime } = createRuntime(fetchMock as unknown as typeof fetch);

    const result = await run(runtime, "buy btc", {
      ...hyperliquidOrder,
      confirmed: true,
    });

    expect(result?.data?.requiresConfirmation).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes("/order")),
    ).toBe(false);
  });

  it("renders missing sessions as session_required without confirmation", async () => {
    const fetchMock = vi.fn();
    const { runtime } = createRuntime(fetchMock as unknown as typeof fetch);
    (runtime.getSetting as ReturnType<typeof vi.fn>).mockImplementation(
      (key: string) => {
        const settings: Record<string, string> = {
          STEWARD_API_URL: "https://steward.local",
          STEWARD_AGENT_ID: "agent-fixture",
          STEWARD_AGENT_TOKEN: "token-fixture",
        };
        return settings[key];
      },
    );

    const result = await run(runtime, "buy btc", hyperliquidOrder);

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({
      outcome: "session_required",
      error: "SESSION_REQUIRED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("marks unknown submit results as poll and do-not-retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.tokenStatusObserved),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.activeHyperliquidSession),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.tokenStatusObserved),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, stewardFixtures.activeHyperliquidSession),
      )
      .mockResolvedValueOnce(jsonResponse(502, stewardFixtures.unknownSubmit));
    const { runtime } = createRuntime(fetchMock as unknown as typeof fetch);

    await run(runtime, "buy btc", hyperliquidOrder);
    const result = await run(runtime, "yes", hyperliquidOrder);

    expect(result?.success).toBe(false);
    expect(result?.data).toMatchObject({
      outcome: "unknown",
      pollRequired: true,
      doNotRetry: true,
      retrySafe: false,
    });
    expect(String(result?.text)).toContain("do not resubmit");
  });
});
