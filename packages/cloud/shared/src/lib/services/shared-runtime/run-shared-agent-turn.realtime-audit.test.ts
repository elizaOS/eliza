/**
 * Pins the fail-closed boundary around mutable factual turns. The model may
 * fabricate, omit attribution, or stay silent; only the server-owned public
 * read can authorize the final Telegram-safe reply.
 */

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ActionResult } from "@elizaos/core";

let searchResult: ActionResult;
let runtimeReply = "";
let runtimeResponded = true;
let runtimeActionResults: ActionResult[] | undefined;
let searchQueries: string[] = [];
let searchObservedAt = 0;

mock.module("../../providers/language-model", () => ({
  hasLanguageModelProviderConfigured: () => true,
}));

mock.module("@elizaos/plugin-web-search", () => ({
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

const { runSharedAgentTurn } = await import("./run-shared-agent-turn");

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
  searchQueries = [];
});

describe("runSharedAgentTurn quiet binding audit", () => {
  test("audits the real refusal caller in quiet mode with only closed diagnostic fields", async () => {
    expect(process.env.VERBOSE_LOGGING ?? "false").toBe("false");
    const { logger } = await import("../../utils/logger");
    const sink = spyOn(console, "info").mockImplementation(() => {});
    try {
      logger.info("quiet-mode-sentinel", { value: 1 });
      runtimeReply = "Bitcoin is currently 63,800 USD according to TradingView.";
      const traceId = "a".repeat(32);
      const result = await runSharedAgentTurn({
        character,
        history: [],
        message: "what is btc price rn",
        capabilityText: "what is btc price rn",
        traceId,
        execution: {
          agentKey: "personal-shared:quiet-audit",
          roomKey: "telegram:quiet-audit",
          channel: { type: "DM", source: "telegram" },
        },
      });
      const records = sink.mock.calls.filter(
        (call) => call[0] === "[shared-realtime] claim binding refused",
      );
      expect(records).toEqual([
        [
          "[shared-realtime] claim binding refused",
          {
            traceId,
            markerCount: 0,
            knownSourceMarkerCount: 0,
            failedPredicateMask: 0,
            reason: "marker_missing",
          },
        ],
      ]);
      expect(sink.mock.calls.some((call) => call[0] === "quiet-mode-sentinel")).toBe(false);
      expect(JSON.stringify(records)).not.toContain("63,800");
      expect(JSON.stringify(records)).not.toContain("TradingView");
      expect(JSON.stringify(records)).not.toContain("https://");
      expect(result.reply).toContain("couldn’t safely bind the requested claim");
    } finally {
      sink.mockRestore();
    }
  });
});
