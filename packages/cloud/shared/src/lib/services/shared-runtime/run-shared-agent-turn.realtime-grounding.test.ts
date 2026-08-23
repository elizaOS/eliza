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
let runtimeActionResults: ActionResult[] | undefined;
let capturedRuntimeInput: Record<string, unknown> | undefined;
let searchQueries: string[] = [];
let searchObservedAt = 0;

mock.module("../../providers/language-model", () => ({
  hasLanguageModelProviderConfigured: () => true,
}));

mock.module("@elizaos/plugin-web-search/edge", () => ({
  runWebSearchEdge: async (query: string) => {
    searchQueries.push(query);
    return {
      ...searchResult,
      data: { ...searchResult.data, query },
    };
  },
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
      ...(runtimeActionResults ? { actionResults: runtimeActionResults } : {}),
    };
  },
  runSharedElizaRuntimeTurnStream: async () => {
    throw new Error("current-data turns must use the buffered verification boundary");
  },
}));

const { runSharedAgentTurn, runSharedAgentTurnStream } = await import("./run-shared-agent-turn");

const character = { name: "Grounding Pin", system: "You are a test persona." };

function groundedSearch(): ActionResult {
  searchObservedAt = Date.now();
  return {
    success: true,
    text: JSON.stringify({ symbol: "BTC", value: "70,000", currency: "USD" }),
    data: {
      actionName: "WEB_SEARCH",
      query: "what is btc price rn",
      provider: "parallel",
      observedAt: searchObservedAt,
      sourceUrls: ["https://example.com/markets/btc-usd"],
      sources: [
        {
          url: "https://example.com/markets/btc-usd",
          text: JSON.stringify({
            url: "https://example.com/markets/btc-usd",
            symbol: "BTC",
            value: "70,000",
            currency: "USD",
            excerpt: "BTC is 70,000 USD.",
          }),
        },
      ],
      truncated: false,
    },
  };
}

beforeEach(() => {
  searchResult = groundedSearch();
  runtimeReply = "BTC is 70,000 USD. [[SOURCE_URL:https://example.com/markets/btc-usd]]";
  runtimeResponded = true;
  runtimeActionResults = undefined;
  capturedRuntimeInput = undefined;
  searchQueries = [];
});

describe("runSharedAgentTurn realtime grounding", () => {
  test("preflights current prices and returns a concise traceable source", async () => {
    const result = await runSharedAgentTurn({
      character,
      history: [],
      message: "what is btc price rn",
      capabilityText: "what is btc price rn",
      execution: {
        agentKey: "personal-shared:test",
        roomKey: "telegram:test",
        channel: { type: "DM", source: "telegram" },
      },
    });

    expect(result.reply).toContain("BTC is 70,000 USD.");
    expect(result.reply).toContain("Source: example.com");
    expect(result.reply).toContain("https://example.com/markets/btc-usd");
    expect(result.reply).toContain(`parallel, checked ${new Date(searchObservedAt).toISOString()}`);
    expect(result.actionResults).toEqual([
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          deliveredReply: expect.stringContaining("Source: example.com"),
          groundingStatus: "verified",
        }),
      }),
    ]);
    expect(JSON.stringify(result.actionResults)).not.toContain("originalModelReply");
    expect(JSON.stringify(result.actionResults)).not.toContain('"sources"');
    expect(JSON.stringify(result.actionResults)).not.toContain('"excerpt"');
    expect(capturedRuntimeInput?.preflightActionResults).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({ query: "BTC price current" }),
      }),
    ]);
    if (!capturedRuntimeInput) throw new Error("runtime input was not captured");
    expect((capturedRuntimeInput.character as { system: string }).system).toContain(
      "Current-data grounding policy",
    );
  });

  test("keeps all raw search receipts internal and exposes one safe public receipt", async () => {
    const followUpSearch: ActionResult = {
      success: true,
      text: JSON.stringify({ symbol: "ETH", value: "3,500", currency: "USD" }),
      data: {
        actionName: "WEB_SEARCH",
        query: "compare with ethereum price",
        provider: "parallel",
        observedAt: Date.UTC(2026, 7, 21, 8, 31),
        sourceUrls: ["https://example.com/markets/eth-usd"],
        sources: [
          {
            url: "https://example.com/markets/eth-usd",
            text: JSON.stringify({
              url: "https://example.com/markets/eth-usd",
              symbol: "ETH",
              value: "3,500",
              currency: "USD",
            }),
          },
        ],
        truncated: false,
      },
    };
    runtimeActionResults = [
      {
        ...groundedSearch(),
        data: {
          ...groundedSearch().data,
          query: "  BTC   PRICE current ",
        },
      },
      followUpSearch,
    ];

    const result = await runSharedAgentTurn({
      character,
      history: [],
      message: "what is btc price rn",
      capabilityText: "what is btc price rn",
    });

    expect(result.actionResults).toHaveLength(1);
    expect(result.actionResults?.[0]?.data?.query).toBe("BTC price current");
    expect(result.actionResults?.[0]?.data?.sourceUrls).toBeUndefined();
    expect(JSON.stringify(result.actionResults)).not.toContain("compare with ethereum price");
    expect(JSON.stringify(result.actionResults)).not.toContain("3,500");
  });

  test("replaces a fabricated value and attribution with a safe answer", async () => {
    runtimeReply = "Bitcoin is currently 63,800 USD according to TradingView.";
    const result = await runSharedAgentTurn({
      character,
      history: [],
      message: "what is btc price rn",
      capabilityText: "what is btc price rn",
    });

    expect(result.reply).not.toContain("63,800");
    expect(result.reply).not.toContain("TradingView");
    expect(result.reply).toContain("couldn’t safely bind the requested claim");
    expect(result.reply).toContain("Source provider: parallel");
    expect(JSON.stringify(result.actionResults)).not.toContain("63,800");
    expect(JSON.stringify(result.actionResults)).not.toContain("TradingView");
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
      message: "weather in Austin today",
      capabilityText: "weather in Austin today",
    });

    expect(result.reply).toContain("can’t verify");
    expect(result.reply).toContain("won’t guess");
    expect(result.reply).not.toContain("72");
    expect(result.reply).not.toContain("WeatherNow");
    expect(result.actionResults?.[0]?.success).toBe(false);
  });

  const privateTurns = [
    ["check my todos", "You have two todos."],
    ["what reminders do I have today?", "You have one reminder today."],
    ["what's on my schedule today?", "Your schedule has a 3 PM meeting."],
    ["what is the status of my order?", "Your order is still processing."],
    ["what is the status of the export?", "The export is still processing."],
    ["please correct my name to Nubs", "Got it — I’ll call you Nubs."],
  ] as const;

  for (const [message, reply] of privateTurns) {
    test(`leaves private turn untouched without public search: ${message}`, async () => {
      runtimeReply = reply;
      const result = await runSharedAgentTurn({ character, history: [], message });
      expect(result.reply).toBe(reply);
      expect(result.actionResults).toBeUndefined();
      expect(capturedRuntimeInput?.preflightActionResults).toBeUndefined();
      expect(searchQueries).toEqual([]);
    });
  }

  test("uses only the authenticated utterance for public-search authorization and query", async () => {
    await runSharedAgentTurn({
      character,
      history: [],
      message: "Server context: private account metadata. User said: what is btc price rn",
      capabilityText: "what is btc price rn",
    });
    expect(searchQueries).toEqual(["BTC price current"]);

    searchQueries = [];
    capturedRuntimeInput = undefined;
    await runSharedAgentTurn({
      character,
      history: [],
      message: "what is btc price rn",
    });
    expect(searchQueries).toEqual([]);
    expect(capturedRuntimeInput?.preflightActionResults).toBeUndefined();

    searchQueries = [];
    capturedRuntimeInput = undefined;
    runtimeReply = "Your todos are available privately.";
    await runSharedAgentTurn({
      character,
      history: [],
      message: "what is btc price rn",
      capabilityText: "check my todos",
    });
    expect(searchQueries).toEqual([]);
    expect(capturedRuntimeInput?.preflightActionResults).toBeUndefined();
  });

  test("does not export prior history for an ambiguous correction", async () => {
    runtimeReply = "";
    runtimeResponded = false;
    const result = await runSharedAgentTurn({
      character,
      history: [
        { role: "user", content: "what is btc price rn" },
        { role: "assistant", content: "Bitcoin is 63,800 USD." },
      ],
      message: "wrong, check again",
      capabilityText: "wrong, check again",
    });

    expect(result.responded).toBe(false);
    expect(searchQueries).toEqual([]);
    expect(capturedRuntimeInput?.preflightActionResults).toBeUndefined();
  });

  test("refreshes selected stale assistant claims before a deictic follow-up", async () => {
    const result = await runSharedAgentTurn({
      character,
      history: [
        { role: "user", content: "what is btc price rn" },
        {
          role: "assistant",
          content: "BTC is 63,800 USD.",
          grounding: {
            kind: "web_search",
            query: "what is btc price rn",
            provider: "parallel",
            observedAt: Date.now() - 60_000,
            sourceUrls: ["https://old.example.com/btc"],
            sources: [{ url: "https://old.example.com/btc", text: "BTC is 63,800 USD." }],
            text: "BTC is 63,800 USD.",
            truncated: false,
          },
        },
      ],
      message: "what about that?",
      capabilityText: "what about that?",
    });

    expect(searchQueries).toEqual(["BTC price current"]);
    expect(result.reply).toContain("70,000 USD");
    expect(result.reply).not.toContain("63,800");
  });

  test("fails closed without search when realtime intent is unsafe or unauthoritative", async () => {
    runtimeReply = "BTC is currently 99,999 USD.";
    for (const input of [
      {
        history: [],
        message: "current BTC price; password=zephyr",
        capabilityText: "current BTC price; password=zephyr",
      },
      {
        history: [
          { role: "user" as const, content: "what is btc price rn" },
          {
            role: "assistant" as const,
            content: "BTC is 63,800 USD.",
            grounding: {
              kind: "web_search" as const,
              query: "what is btc price rn",
              provider: "parallel" as const,
              observedAt: Date.now() - 60_000,
              sourceUrls: ["https://old.example.com/btc"],
              sources: [{ url: "https://old.example.com/btc", text: "BTC is 63,800 USD." }],
              text: "BTC is 63,800 USD.",
              truncated: false as const,
            },
          },
        ],
        message: "what about that?",
      },
      {
        history: [],
        message: "Server context:\npassword=zephyr\nUser said: current BTC price",
      },
    ]) {
      searchQueries = [];
      const result = await runSharedAgentTurn({ character, ...input });
      expect(searchQueries).toEqual([]);
      expect(result.reply).toContain("can’t verify");
      expect(result.reply).not.toContain("99,999");
      expect(result.reply).not.toContain("63,800");
    }
  });

  test("buffers current-data streaming so no unverified prefix escapes", async () => {
    const result = await runSharedAgentTurnStream({
      character,
      history: [],
      message: "latest ethereum price",
      capabilityText: "latest ethereum price",
    });
    if (!result.parts) throw new Error("stream returned no parts");
    const parts = [];
    for await (const part of result.parts) parts.push(part);

    expect(parts.map((part) => part.type)).toEqual(["text-delta", "finish"]);
    expect(parts[0]?.text).toContain("Source: example.com");
    expect(parts[1]?.text).toContain("Source: example.com");
    expect(parts[1]?.type === "finish" ? parts[1].actionResults : undefined).toEqual([
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          query: "ETHEREUM price current",
          deliveredReply: expect.stringContaining("Source: example.com"),
        }),
      }),
    ]);
    const terminalReceipt = JSON.stringify(
      parts[1]?.type === "finish" ? parts[1].actionResults : undefined,
    );
    expect(terminalReceipt).not.toContain("originalModelReply");
    expect(terminalReceipt).not.toContain('"sources"');
    expect(terminalReceipt).not.toContain('"excerpt"');
  });
});
