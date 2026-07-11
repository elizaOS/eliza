/**
 * Provider coverage for Steward trading planner state. The provider is driven
 * through the real StewardTradingService with sanitized HTTP fixtures so it
 * proves capability/session exposure without live credentials or network.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/core", async () => {
  return await import("../__tests__/core-vitest-mock.js");
});

import { stewardFixtures } from "../services/__fixtures__/steward-trade-responses.js";
import { StewardTradingService } from "../services/steward-trading-service.js";
import { stewardTradingProvider } from "./steward-trading-provider.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function runtimeWithService(fetchMock: typeof fetch): IAgentRuntime {
  const getService = vi.fn(() => null);
  const runtime = {
    agentId: "test-agent",
    getSetting: vi.fn((key: string) => {
      const settings: Record<string, string> = {
        STEWARD_API_URL: "https://steward.local",
        STEWARD_AGENT_ID: "agent-fixture",
        STEWARD_AGENT_TOKEN: "token-fixture",
        STEWARD_HYPERLIQUID_TRADE_SESSION_ID: "sess_hl_fixture",
        STEWARD_POLYMARKET_TRADE_SESSION_ID: "sess_pm_fixture",
      };
      return settings[key];
    }),
    getService,
  } as unknown as IAgentRuntime;
  const service = new StewardTradingService(runtime, {
    fetch: fetchMock,
    sleep: async () => undefined,
    maxRetries: 1,
  });
  getService.mockImplementation((name: string) =>
    name === StewardTradingService.serviceType ? service : null,
  );
  return runtime;
}

describe("stewardTradingProvider", () => {
  it("exposes capability and venue session status without secrets", async () => {
    const activePolymarketSession = {
      ok: true,
      data: {
        id: "sess_pm_fixture",
        agentId: "agent-fixture",
        venue: "polymarket",
        walletAddress: "0x1111111111111111111111111111111111111111",
        status: "active",
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token-status")) {
        return jsonResponse(200, stewardFixtures.tokenStatusObserved);
      }
      if (url.endsWith("/v1/trade/sessions/sess_hl_fixture")) {
        return jsonResponse(200, stewardFixtures.activeHyperliquidSession);
      }
      if (url.endsWith("/v1/trade/sessions/sess_pm_fixture")) {
        return jsonResponse(200, activePolymarketSession);
      }
      return jsonResponse(404, { ok: false, error: "unexpected route" });
    });
    const runtime = runtimeWithService(fetchMock as unknown as typeof fetch);

    const result = await stewardTradingProvider.get(
      runtime,
      { content: {} } as Memory,
      {} as State,
    );

    expect(result.values).toMatchObject({
      stewardTradingReady: true,
      stewardTradingCapability: "steward-self",
      stewardTradingAgentId: "agent-fixture",
    });
    expect(result.values?.stewardTradingAccounts).toEqual([
      {
        venue: "hyperliquid",
        status: "active",
        accountId: "wallet_fixture",
        sessionId: "sess_hl_fixture",
      },
      {
        venue: "polymarket",
        status: "active",
        accountId: "0x1111111111111111111111111111111111111111",
        sessionId: "sess_pm_fixture",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("token-fixture");
  });
});
