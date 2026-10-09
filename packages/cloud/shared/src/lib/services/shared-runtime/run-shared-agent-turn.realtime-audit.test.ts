/**
 * Pins the fail-closed boundary around mutable factual turns. The model may
 * fabricate, omit attribution, or stay silent; only the server-owned public
 * read can authorize the final Telegram-safe reply.
 */

import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ActionResult } from "@elizaos/core";
import { CURRENT_WEATHER_LIMITS, runCurrentUsWeatherSearch } from "./shared-current-weather";
import {
  requireTraceableRealtimeSearch,
  resolveSharedPublicSearchIntent,
  resolveSharedRealtimeRequirement,
} from "./shared-realtime-grounding";
import { sharedPublicWebGrounding } from "./shared-runtime-history-policy";

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

test("retains the public search path for international current weather", async () => {
  const url = "https://weather.example/paris";
  const statement = "Paris, France is 18 Celsius and cloudy.";
  searchResult = {
    success: true,
    text: statement,
    data: {
      actionName: "WEB_SEARCH",
      query: "current public weather in Paris, France",
      provider: "parallel",
      observedAt: Date.now(),
      sourceUrls: [url],
      sources: [{ url, text: statement }],
      truncated: false,
    },
  };
  runtimeReply = `${statement} [[SOURCE_URL:${url}]]`;
  const result = await runSharedAgentTurn({
    character,
    history: [],
    message: "What is the current weather in Paris, France?",
    capabilityText: "What is the current weather in Paris, France?",
    execution: {
      agentKey: "personal-shared:weather-audit",
      roomKey: "telegram:weather-audit",
      channel: { type: "DM", source: "telegram" },
    },
  });
  expect(searchQueries).toEqual(["current public weather in Paris, France"]);
  expect(result.reply).toContain(statement);
  expect(result.reply).toContain(url);
});

test("general public search admission is distinct from freshness preflight and retains topic authority", () => {
  for (const message of [
    "Search the web for Bun installation instructions",
    "What are the latest iPhone prices?",
    "Search for the best running shoes",
    "Find research papers about transformer inference",
    "What is the latest version of Bun?",
    "Search the web for Gmail API documentation",
    "Search for the latest model context limits from Cerebras",
  ]) {
    expect(resolveSharedPublicSearchIntent(message, [])?.kind).toBe("general");
  }
  expect(
    resolveSharedRealtimeRequirement("What are today's headlines about Apple?", [])?.query,
  ).toBe("latest public Apple news");
  expect(
    resolveSharedRealtimeRequirement(
      "What is the latest news about modern quantum computing research breakthroughs?",
      [],
    )?.query,
  ).toBe("latest public modern quantum computing research breakthroughs news");
  expect(
    resolveSharedPublicSearchIntent("Search the web for Bun installation instructions?", []),
  ).toEqual({ kind: "general", topic: "Bun installation instructions" });
  expect(
    resolveSharedPublicSearchIntent(
      "Search for JavaScript runtime official installation documentation",
      [],
    ),
  ).toEqual({ kind: "general", topic: "JavaScript runtime official installation documentation" });
  expect(
    resolveSharedPublicSearchIntent("Search the web for C# installation documentation?", []),
  ).toEqual({ kind: "general", topic: "C# installation documentation" });
  expect(
    resolveSharedPublicSearchIntent('Search the web for "Bun installation instructions"?', []),
  ).toEqual({ kind: "general", topic: '"Bun installation instructions"' });
  const completeTopic = "public technical documentation ".repeat(16).trim();
  expect(resolveSharedPublicSearchIntent("Search the web for " + completeTopic + "?", [])).toEqual({
    kind: "general",
    topic: completeTopic,
  });
  for (const message of [
    "Search the web for my inbox messages",
    "Search localhost for current news",
    "Search the web for that",
    "Search for my calendar",
    "Weather now",
  ])
    expect(resolveSharedPublicSearchIntent(message, [])).toBeUndefined();
});

test("closed weather failure reason survives traceability and history without arbitrary error text", () => {
  const query = "current public weather in Springfield, Missouri";
  const receipt = requireTraceableRealtimeSearch(
    {
      success: false,
      text: "Unavailable",
      data: {
        actionName: "WEB_SEARCH",
        query,
        unavailableReason: "CURRENT_WEATHER_SOURCE_UNAVAILABLE",
        sourceDiagnostics: [{ hop: "points", outcome: "http-error", httpStatus: 403 }],
      },
    },
    query,
  );
  expect(sharedPublicWebGrounding([receipt])).toMatchObject({
    kind: "web_search_unavailable",
    unavailableReason: "CURRENT_WEATHER_SOURCE_UNAVAILABLE",
    sourceDiagnostics: [{ hop: "points", outcome: "http-error", httpStatus: 403 }],
  });
  const hostile = requireTraceableRealtimeSearch(
    {
      success: false,
      data: {
        actionName: "WEB_SEARCH",
        query,
        unavailableReason: "private payload must not survive",
      },
    },
    query,
  );
  expect(sharedPublicWebGrounding([hostile])).toMatchObject({
    unavailableReason: "CURRENT_WEATHER_RECEIPT_UNTRACEABLE",
  });
});

test("closed weather source-hop diagnostics distinguish HTTP, network and JSON failures without payload text", async () => {
  const query = "current public weather in Springfield, Missouri";
  for (const [fetchImpl, expected, code] of [
    [
      async () => new Response("private provider body", { status: 403 }),
      { hop: "geocoder", outcome: "http-error", httpStatus: 403 },
      "CURRENT_WEATHER_SOURCE_UNAVAILABLE",
    ],
    [
      async () => {
        throw new TypeError("private transport details");
      },
      { hop: "geocoder", outcome: "network" },
      "CURRENT_WEATHER_SOURCE_UNAVAILABLE",
    ],
    [
      async () =>
        new Response("private malformed body", { headers: { "content-type": "application/json" } }),
      { hop: "geocoder", outcome: "shape", httpStatus: 200 },
      "CURRENT_WEATHER_SOURCE_UNAVAILABLE",
    ],
    [
      async () =>
        new Response("x".repeat(CURRENT_WEATHER_LIMITS.bodyBytes + 1), {
          headers: { "content-type": "application/json" },
        }),
      { hop: "geocoder", outcome: "body-limit", httpStatus: 200 },
      "CURRENT_WEATHER_SOURCE_UNAVAILABLE",
    ],
    [
      async () => Response.json({ invalid: "private body must not survive" }),
      { hop: "geocoder", outcome: "validation", httpStatus: 200 },
      "CURRENT_WEATHER_GEOCODER_SHAPE",
    ],
  ] as const) {
    const read = await runCurrentUsWeatherSearch(query, {
      fetchImpl: fetchImpl as typeof fetch,
      cache: false,
    });
    expect(read.success).toBe(false);
    const receipt = requireTraceableRealtimeSearch(read, query, Date.now(), "weather");
    const retained = sharedPublicWebGrounding([receipt]);
    expect(retained?.kind).toBe("web_search_unavailable");
    if (retained?.kind !== "web_search_unavailable")
      throw new Error("Expected an unavailable weather receipt");
    expect(retained.unavailableReason).toBe(code);
    expect(retained.sourceDiagnostics?.length).toBe(1);
    const diagnostic = retained.sourceDiagnostics![0]!;
    expect(typeof diagnostic.elapsedMs).toBe("number");
    expect(diagnostic.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(diagnostic.elapsedMs).toBeLessThanOrEqual(6000);
    const { elapsedMs: _elapsed, ...closedFields } = diagnostic;
    expect(closedFields).toEqual(expected);
    expect(JSON.stringify(retained)).not.toContain("private");
  }
});
