/** Deterministic adversarial coverage for Shared current-data grounding gates. */

import { describe, expect, test } from "bun:test";
import type { SharedRuntimePublicGrounding } from "../../../db/schemas/shared-runtime-history";
import {
  finalizeSharedRealtimeReply,
  requireTraceableRealtimeSearch,
  resolveSharedRealtimeRequirement,
  validateSharedRealtimeReply,
} from "./shared-realtime-grounding";

const observedAt = Date.UTC(2026, 7, 22, 7, 0, 0);
const grounding: SharedRuntimePublicGrounding = {
  kind: "web_search",
  query: "what is btc price rn",
  provider: "parallel",
  observedAt,
  sourceUrls: ["https://coin.example/bitcoin"],
  text: JSON.stringify({
    results: [
      {
        url: "https://coin.example/bitcoin",
        title: "Bitcoin price",
        excerpt: "Bitcoin is 77,357.93 USD at 07:00 UTC.",
      },
    ],
  }),
  truncated: false,
};

describe("Shared realtime request classification", () => {
  for (const [message, domain] of [
    ["what is btc price rn", "markets"],
    ["weather in Austin", "weather"],
    ["latest election news", "news"],
    ["what's the Lakers score?", "sports"],
    ["who is the current CEO of Example Corp?", "mutable_fact"],
    ["check the web and give me a source", "explicit_verification"],
  ] as const) {
    test(`requires ${domain} grounding for ${message}`, () => {
      expect(resolveSharedRealtimeRequirement(message, [])?.domain).toBe(domain);
    });
  }

  test("does not force live lookup for static or explicitly historical facts", () => {
    expect(resolveSharedRealtimeRequirement("What is Bitcoin?", [])).toBeUndefined();
    expect(resolveSharedRealtimeRequirement("Explain proof of work", [])).toBeUndefined();
    expect(resolveSharedRealtimeRequirement("Why did BTC move in 2017?", [])).toBeUndefined();
  });

  test("inherits a current-data requirement through correction and retry", () => {
    const history = [
      { role: "user" as const, content: "what is btc price rn" },
      {
        role: "assistant" as const,
        content: "Bitcoin is currently 63,800 USD according to TradingView",
      },
    ];
    expect(resolveSharedRealtimeRequirement("that's wrong, check again", history)).toMatchObject({
      domain: "markets",
      correction: true,
    });
    expect(resolveSharedRealtimeRequirement("check the web", history)?.query).toContain(
      "what is btc price rn",
    );
  });
});

describe("Shared realtime receipts and Telegram-safe replies", () => {
  test("rejects a successful search that has no traceable source", () => {
    expect(
      requireTraceableRealtimeSearch(
        {
          success: true,
          text: "Bitcoin is 77,357.93 USD",
          data: { actionName: "WEB_SEARCH", query: "BTC price", provider: "parallel" },
        },
        "BTC price",
        observedAt,
      ),
    ).toMatchObject({
      success: false,
      data: { actionName: "WEB_SEARCH", query: "BTC price" },
    });
  });

  test("accepts only values, currency, URLs, and attribution present in evidence", () => {
    if (grounding.kind !== "web_search") throw new Error("fixture grounding must be available");
    expect(
      validateSharedRealtimeReply(
        "Bitcoin is 77,357.93 USD. [[SOURCE_URL:https://coin.example/bitcoin]]",
        grounding,
      ),
    ).toBe(true);
    expect(validateSharedRealtimeReply("Bitcoin is 63,800 USD.", grounding)).toBe(false);
    expect(
      validateSharedRealtimeReply("Bitcoin is 77,357.93 USD according to TradingView.", grounding),
    ).toBe(false);
    expect(
      validateSharedRealtimeReply(
        "Bitcoin is 77,357.93 USD according to tradingview. [[SOURCE_URL:https://coin.example/bitcoin]]",
        grounding,
      ),
    ).toBe(false);
    expect(
      validateSharedRealtimeReply(
        "Bitcoin is 77,357.93 USD: https://forged.example/price",
        grounding,
      ),
    ).toBe(false);
    expect(validateSharedRealtimeReply("?", grounding)).toBe(false);
  });

  test("adds concise source, provider, and checked time for Telegram", () => {
    const reply = finalizeSharedRealtimeReply(
      "Bitcoin is 77,357.93 USD. [[SOURCE_URL:https://coin.example/bitcoin]]",
      grounding,
    );
    expect(reply).toContain("Bitcoin is 77,357.93 USD.");
    expect(reply).toContain("https://coin.example/bitcoin");
    expect(reply).toContain("parallel");
    expect(reply).toContain("2026-08-22T07:00:00.000Z");
    expect(reply).not.toContain("[[SOURCE_URL:");
  });

  test("recovers honestly from unavailable tools and punctuation-only model output", () => {
    const unavailable: SharedRuntimePublicGrounding = {
      kind: "web_search_unavailable",
      query: "weather now",
      observedAt,
    };
    const reply = finalizeSharedRealtimeReply("?", unavailable);
    expect(reply).toContain("can’t verify");
    expect(reply).toContain("won’t guess");
    expect(reply).not.toMatch(/\b\d[\d,.]*\b/u);
  });
});
