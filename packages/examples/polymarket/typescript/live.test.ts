import { describe, expect, test } from "vitest";

import { AgentRuntime, createCharacter, type Character } from "@elizaos/core";
import sqlPlugin from "@elizaos/plugin-sql";
import { initializeClobClient } from "@elizaos/plugin-polymarket";

describe("live integration (Polymarket CLOB)", () => {
  test("fetches markets from real API (gated)", async () => {
    if (process.env.POLYMARKET_LIVE_TESTS !== "1") return;

    const key = "0x" + "11".repeat(32);
    const character: Character = createCharacter({
      name: "LiveTest",
      bio: "live",
      secrets: {
        EVM_PRIVATE_KEY: key,
        POLYMARKET_PRIVATE_KEY: key,
        CLOB_API_URL: "https://clob.polymarket.com",
      },
    });

    const runtime = new AgentRuntime({ character, plugins: [sqlPlugin] });
    await runtime.initialize();

    try {
      const client = await initializeClobClient(runtime);
      const resp = await client.getMarkets(undefined);
      expect(Array.isArray(resp.data)).toBe(true);
      expect(resp.data.length).toBeGreaterThan(0);
      const first = resp.data[0];
      expect(typeof first.condition_id).toBe("string");
      expect(typeof first.active).toBe("boolean");
    } finally {
      await runtime.stop();
    }
  });
});

