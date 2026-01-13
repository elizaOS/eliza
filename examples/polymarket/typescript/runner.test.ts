import { describe, expect, test } from "bun:test";

import { AgentRuntime, type Character } from "@elizaos/core";
import { initWalletProvider } from "@elizaos/plugin-evm";
import { getWalletAddress } from "@elizaos/plugin-polymarket";
import sqlPlugin from "@elizaos/plugin-sql";

import { bestPrice, pickFirstActiveMarket } from "./runner";

describe("bestPrice", () => {
  test("returns nulls when no bids/asks", () => {
    const r = bestPrice({ bids: [], asks: [] });
    expect(r.bestBid).toBeNull();
    expect(r.bestAsk).toBeNull();
  });

  test("parses best bid/ask", () => {
    const r = bestPrice({
      bids: [{ price: "0.45", size: "1" }],
      asks: [{ price: "0.55", size: "1" }],
    });
    expect(r.bestBid).toBe(0.45);
    expect(r.bestAsk).toBe(0.55);
  });
});

describe("pickFirstActiveMarket", () => {
  test("paginates and picks first active open market", async () => {
    const page1 = {
      limit: 1,
      count: 2,
      next_cursor: "cursor2",
      data: [
        {
          condition_id: "c1",
          question_id: "q1",
          tokens: [
            { token_id: "t1", outcome: "YES" },
            { token_id: "t2", outcome: "NO" },
          ],
          rewards: {
            min_size: 0,
            max_spread: 0,
            event_start_date: "",
            event_end_date: "",
            in_game_multiplier: 0,
            reward_epoch: 0,
          },
          minimum_order_size: "0",
          minimum_tick_size: "0.01",
          category: "cat",
          end_date_iso: "",
          game_start_time: "",
          question: "inactive",
          market_slug: "",
          min_incentive_size: "",
          max_incentive_spread: "",
          active: false,
          closed: false,
          seconds_delay: 0,
          icon: "",
          fpmm: "",
        },
      ],
    };

    const page2 = {
      ...page1,
      next_cursor: "",
      data: [
        {
          ...page1.data[0],
          question: "winner",
          active: true,
          closed: false,
          tokens: [
            { token_id: "tok_yes", outcome: "YES" },
            { token_id: "tok_no", outcome: "NO" },
          ],
          minimum_tick_size: "0.001",
        },
      ],
    };

    let calls = 0;
    const client = {
      getMarkets: async (cursor?: string) => {
        calls += 1;
        if (!cursor) return page1;
        return page2;
      },
    };

    const pick = await pickFirstActiveMarket(client, 2);
    expect(pick.tokenId).toBe("tok_yes");
    expect(pick.marketLabel).toBe("winner");
    expect(pick.tickSize).toBe(0.001);
    expect(calls).toBe(2);
  });

  test("throws when no active market within max pages", async () => {
    const client = {
      getMarkets: async () => ({
        limit: 1,
        count: 1,
        next_cursor: "",
        data: [],
      }),
    };
    await expect(pickFirstActiveMarket(client, 1)).rejects.toThrow();
  });
});

describe("wallet parity integration (real plugins)", () => {
  test("detects mismatch when POLYMARKET_PRIVATE_KEY != EVM_PRIVATE_KEY", async () => {
    const keyEvm = "0x" + "11".repeat(32);
    const keyPoly = "0x" + "22".repeat(32);
    const character: Character = {
      name: "Test",
      bio: "t",
      settings: {
        secrets: {
          EVM_PRIVATE_KEY: keyEvm,
          POLYMARKET_PRIVATE_KEY: keyPoly,
          CLOB_API_URL: "https://clob.polymarket.com",
        },
      },
    };
    const runtime = new AgentRuntime({ character, plugins: [sqlPlugin] });
    await runtime.initialize();

    try {
      const polyAddr = getWalletAddress(runtime);
      const evm = await initWalletProvider(runtime);
      const evmAddr = evm.getAddress();
      expect(polyAddr.toLowerCase()).not.toBe(evmAddr.toLowerCase());
    } finally {
      await runtime.stop();
    }
  });
});

