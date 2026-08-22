/**
 * Pins the fail-closed boundary around mutable factual turns. The model may
 * fabricate, omit attribution, or stay silent; only the server-owned public
 * read can authorize the final Telegram-safe reply.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { ActionResult } from "@elizaos/core/edge";

let searchResult: ActionResult;
let runtimeReply = "";
let runtimeResponded = true;
let capturedRuntimeInput: Record<string, unknown> | undefined;

mock.module("../../providers/language-model", () => ({
  hasLanguageModelProviderConfigured: () => true,
}));

mock.module("@elizaos/plugin-web-search/edge", () => ({
  runWebSearchEdge: async () => searchResult,
}));

mock.module("./shared-eliza-runtime", () => ({
  runSharedElizaRuntimeTurn: async (input: Record<string, unknown>) => {
    capturedRuntimeInput = input;
    const history = input.history as Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
    return {
      reply: runtimeReply,
      responded: runtimeResponded,
      history: runtimeResponded
        ? [
            ...history,
            { role: "user" as const, content: String(input.message) },
            { role: "assistant" as const, content: runtimeReply },
          ]
        : [...history, { role: "user" as const, content: String(input.message) }],
      model: String(input.model),
      degraded: false,
    };
  },
  runSharedElizaRuntimeTurnStream: async () => {
    throw new Error("current-data turns must use the buffered verification boundary");
  },
}));

const { runSharedAgentTurn, runSharedAgentTurnStream } = await import("./run-shared-agent-turn");

const character = { name: "Grounding Pin", system: "You are a test persona." };

function groundedSearch(): ActionResult {
  return {
    success: true,
    text: JSON.stringify({ symbol: "BTC", value: "70,000", currency: "USD" }),
    data: {
      actionName: "WEB_SEARCH",
      query: "what is btc price rn",
      provider: "parallel",
      observedAt: Date.UTC(2026, 7, 21, 8, 30),
      sourceUrls: ["https://example.com/markets/btc-usd"],
      truncated: false,
    },
  };
}

beforeEach(() => {
  searchResult = groundedSearch();
  runtimeReply = "BTC is 70,000 USD. [[SOURCE_URL:https://example.com/markets/btc-usd]]";
  runtimeResponded = true;
  capturedRuntimeInput = undefined;
});

describe("runSharedAgentTurn realtime grounding", () => {
  test("preflights current prices and returns a concise traceable source", async () => {
    const result = await runSharedAgentTurn({
      character,
      history: [],
      message: "what is btc price rn",
      execution: {
        agentKey: "personal-shared:test",
        roomKey: "telegram:test",
        channel: { type: "DM", source: "telegram" },
      },
    });

    expect(result.reply).toContain("BTC is 70,000 USD.");
    expect(result.reply).toContain("Source: example.com");
    expect(result.reply).toContain("https://example.com/markets/btc-usd");
    expect(result.reply).toContain("parallel, checked 2026-08-21T08:30:00.000Z");
    expect(result.actionResults).toEqual([searchResult]);
    expect(capturedRuntimeInput?.preflightActionResults).toEqual([searchResult]);
    if (!capturedRuntimeInput) throw new Error("runtime input was not captured");
    expect((capturedRuntimeInput.character as { system: string }).system).toContain(
      "Current-data grounding policy",
    );
  });

  test("replaces a fabricated value and attribution with a safe answer", async () => {
    runtimeReply = "Bitcoin is currently 63,800 USD according to TradingView.";
    const result = await runSharedAgentTurn({
      character,
      history: [],
      message: "what is btc price rn",
    });

    expect(result.reply).not.toContain("63,800");
    expect(result.reply).not.toContain("TradingView");
    expect(result.reply).toContain("couldn’t safely verify a single current value");
    expect(result.reply).toContain("Source provider: parallel");
  });

  test("fails closed when search has no traceable source", async () => {
    searchResult = {
      success: true,
      text: "A result that does not name or link its source",
      data: {
        actionName: "WEB_SEARCH",
        query: "weather today",
        provider: "parallel",
        observedAt: Date.now(),
      },
    };
    runtimeReply = "It is 72 degrees according to WeatherNow.";
    const result = await runSharedAgentTurn({
      character,
      history: [],
      message: "weather today",
    });

    expect(result.reply).toContain("can’t verify");
    expect(result.reply).toContain("won’t guess");
    expect(result.reply).not.toContain("72");
    expect(result.reply).not.toContain("WeatherNow");
    expect(result.actionResults?.[0]?.success).toBe(false);
  });

  test("turns model silence into useful correction recovery", async () => {
    runtimeReply = "";
    runtimeResponded = false;
    const result = await runSharedAgentTurn({
      character,
      history: [
        { role: "user", content: "what is btc price rn" },
        { role: "assistant", content: "Bitcoin is 63,800 USD." },
      ],
      message: "wrong, check again",
    });

    expect(result.responded).toBe(true);
    expect(result.reply).toContain("couldn’t safely verify a single current value");
    expect(result.reply).not.toMatch(/^\?+$/u);
  });

  test("buffers current-data streaming so no unverified prefix escapes", async () => {
    const result = await runSharedAgentTurnStream({
      character,
      history: [],
      message: "latest ethereum price",
    });
    if (!result.parts) throw new Error("stream returned no parts");
    const parts = [];
    for await (const part of result.parts) parts.push(part);

    expect(parts.map((part) => part.type)).toEqual(["text-delta", "finish"]);
    expect(parts[0]?.text).toContain("Source: example.com");
    expect(parts[1]?.text).toContain("Source: example.com");
    expect(parts[1]?.type === "finish" ? parts[1].actionResults : undefined).toEqual([
      searchResult,
    ]);
  });
});
