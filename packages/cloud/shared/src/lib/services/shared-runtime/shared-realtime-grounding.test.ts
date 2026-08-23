/** Deterministic adversarial coverage for Shared current-data grounding gates. */

import { describe, expect, test } from "bun:test";
import type { SharedRuntimePublicGrounding } from "../../../db/schemas/shared-runtime-history";
import {
  createMatchingRealtimeSearchRunner,
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
  sources: [
    {
      url: "https://coin.example/bitcoin",
      text: JSON.stringify({
        url: "https://coin.example/bitcoin",
        title: "Bitcoin price",
        excerpt: "Bitcoin is 77,357.93 USD at 07:00 UTC.",
      }),
    },
  ],
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

  for (const message of [
    "what temperature should I bake bread at?",
    "that's a steep price for a laptop, right?",
    "tell me a joke about bitcoin price",
    "score this essay",
    "could you wind the clock?",
    "bitcoin price volatility is an interesting topic",
  ]) {
    test(`does not leak an ambiguous ordinary request to public search: ${message}`, () => {
      expect(resolveSharedRealtimeRequirement(message, [])).toBeUndefined();
    });
  }

  test("accepts explicit public lookup questions and terse domain-first lookups", () => {
    expect(resolveSharedRealtimeRequirement("is it raining in Austin?", [])?.domain).toBe(
      "weather",
    );
    expect(resolveSharedRealtimeRequirement("BTC price", [])?.domain).toBe("markets");
  });

  for (const message of [
    "check my todos",
    "can you check that for me",
    "confirm the meeting",
    "send me the link",
    "what's on my schedule today",
    "what is the status of my order",
  ]) {
    test(`never sends private state to public search: ${message}`, () => {
      expect(resolveSharedRealtimeRequirement(message, [])).toBeUndefined();
    });
  }

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

  test("does not revive an older public topic past a newer private turn", () => {
    const history = [
      { role: "user" as const, content: "what is btc price rn" },
      { role: "assistant" as const, content: "I could not verify it." },
      { role: "user" as const, content: "what is on my schedule today" },
      { role: "assistant" as const, content: "Your schedule is unavailable." },
    ];
    expect(resolveSharedRealtimeRequirement("that's wrong, check again", history)).toBeUndefined();
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

  test("rejects truncated and hostile-overflow receipts even when they contain URLs", () => {
    for (const extra of [{ truncated: true }, { truncated: false, evidenceOverflowed: true }]) {
      expect(
        requireTraceableRealtimeSearch(
          {
            success: true,
            text: "Bitcoin is 77,357.93 USD",
            data: {
              actionName: "WEB_SEARCH",
              query: "BTC price",
              provider: "parallel",
              sources: [{ url: "https://coin.example/bitcoin", text: "77,357.93 USD" }],
              ...extra,
            },
          },
          "BTC price",
          observedAt,
        ),
      ).toMatchObject({ success: false });
    }
  });

  test("binds a successful receipt to the exact action, query, provider, and observation", () => {
    const base = {
      success: true,
      text: "Bitcoin is 77,357.93 USD",
      data: {
        actionName: "WEB_SEARCH",
        query: "BTC price",
        provider: "parallel",
        observedAt,
        truncated: false,
        sources: [{ url: "https://coin.example/bitcoin", text: "Bitcoin is 77,357.93 USD" }],
      },
    };
    expect(requireTraceableRealtimeSearch(base, " btc  PRICE ", observedAt)).toMatchObject({
      success: true,
    });
    for (const data of [
      { ...base.data, actionName: "OTHER_ACTION" },
      { ...base.data, query: "ETH price" },
      { ...base.data, provider: "forged" },
      { ...base.data, observedAt: observedAt - 5 * 60 * 1000 - 1 },
    ]) {
      expect(
        requireTraceableRealtimeSearch({ ...base, data }, "BTC price", observedAt),
      ).toMatchObject({ success: false });
    }
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

  test("rejects cross-result value-to-URL misattribution", () => {
    if (grounding.kind !== "web_search") throw new Error("fixture grounding must be available");
    const divided: SharedRuntimePublicGrounding = {
      ...grounding,
      sourceUrls: ["https://coin.example/a", "https://coin.example/b"],
      sources: [
        { url: "https://coin.example/a", text: "Bitcoin is 70,000 USD." },
        { url: "https://coin.example/b", text: "Bitcoin is 77,357.93 USD." },
      ],
    };
    if (divided.kind !== "web_search") throw new Error("fixture grounding must be available");
    expect(
      validateSharedRealtimeReply(
        "Bitcoin is 77,357.93 USD. [[SOURCE_URL:https://coin.example/a]]",
        divided,
      ),
    ).toBe(false);
    expect(
      validateSharedRealtimeReply(
        "Bitcoin is 77,357.93 USD. [[SOURCE_URL:https://coin.example/b]]",
        divided,
      ),
    ).toBe(true);
  });

  test("drops an unsupported segment while retaining independently bound claims", () => {
    const divided: SharedRuntimePublicGrounding = {
      ...grounding,
      sourceUrls: ["https://coin.example/btc", "https://coin.example/eth"],
      sources: [
        { url: "https://coin.example/btc", text: "BTC is 70,000 USD." },
        { url: "https://coin.example/eth", text: "ETH is 3,500 USD." },
      ],
    };
    const delivered = finalizeSharedRealtimeReply(
      "BTC is 99,000 USD. [[SOURCE_URL:https://coin.example/btc]] ETH is 3,500 USD. [[SOURCE_URL:https://coin.example/eth]] Unsupported trailing prose.",
      divided,
    );
    expect(delivered).not.toContain("99,000");
    expect(delivered).not.toContain("Unsupported trailing prose");
    expect(delivered).toContain("ETH is 3,500 USD.");
    expect(delivered).toContain("https://coin.example/eth");
    expect(delivered).toContain("left out part of the draft");
    expect(delivered).not.toContain("https://coin.example/btc");
  });

  test("allows a source-bound rounded market value without accepting an unrelated number", () => {
    if (grounding.kind !== "web_search") throw new Error("fixture grounding must be available");
    expect(
      validateSharedRealtimeReply(
        "Bitcoin is about 77,400 USD. [[SOURCE_URL:https://coin.example/bitcoin]]",
        grounding,
      ),
    ).toBe(true);
    expect(
      validateSharedRealtimeReply(
        "Bitcoin is about 81,000 USD. [[SOURCE_URL:https://coin.example/bitcoin]]",
        grounding,
      ),
    ).toBe(false);
  });

  test("rejects qualitative contradictions and unsupported predicates", () => {
    if (grounding.kind !== "web_search") throw new Error("fixture grounding must be available");
    const executiveGrounding: SharedRuntimePublicGrounding = {
      ...grounding,
      sourceUrls: ["https://company.example/leadership"],
      sources: [
        {
          url: "https://company.example/leadership",
          text: "Alice Example is the current CEO of Example Corp.",
        },
      ],
    };
    if (executiveGrounding.kind !== "web_search") {
      throw new Error("fixture grounding must be available");
    }

    expect(
      validateSharedRealtimeReply(
        "Alice Example is the current CEO of Example Corp. [[SOURCE_URL:https://company.example/leadership]]",
        executiveGrounding,
      ),
    ).toBe(true);
    expect(
      validateSharedRealtimeReply(
        "Alice Example is not the current CEO of Example Corp. [[SOURCE_URL:https://company.example/leadership]]",
        executiveGrounding,
      ),
    ).toBe(false);
    expect(
      validateSharedRealtimeReply(
        "Alice Example resigned as CEO of Example Corp. [[SOURCE_URL:https://company.example/leadership]]",
        executiveGrounding,
      ),
    ).toBe(false);
  });

  test("retains short semantic predicates when binding a claim to evidence", () => {
    if (grounding.kind !== "web_search") throw new Error("fixture grounding must be available");
    const marker = "[[SOURCE_URL:https://coin.example/direction]]";
    const directionGrounding = (text: string): SharedRuntimePublicGrounding => ({
      ...grounding,
      sourceUrls: ["https://coin.example/direction"],
      sources: [{ url: "https://coin.example/direction", text }],
    });

    expect(
      validateSharedRealtimeReply(`BTC is up. ${marker}`, directionGrounding("BTC is up.")),
    ).toBe(true);
    for (const [claim, evidence] of [
      ["BTC is up", "BTC is down"],
      ["BTC is not up", "BTC is not down"],
      ["Bitcoin price is up at 120 USD", "Bitcoin price is down at 120 USD"],
    ] as const) {
      const result = directionGrounding(evidence);
      if (result.kind !== "web_search") throw new Error("fixture grounding must be available");
      expect(validateSharedRealtimeReply(`${claim}. ${marker}`, result)).toBe(false);
    }
  });

  test("rejects subject-object and numeric-order reversals", () => {
    const marker = "[[SOURCE_URL:https://example.com/result]]";
    const withEvidence = (text: string): SharedRuntimePublicGrounding => ({
      ...grounding,
      sourceUrls: ["https://example.com/result"],
      sources: [{ url: "https://example.com/result", text }],
    });
    expect(
      validateSharedRealtimeReply(
        `Alice replaced Bob. ${marker}`,
        withEvidence("Alice replaced Bob."),
      ),
    ).toBe(true);
    expect(
      validateSharedRealtimeReply(
        `Alice replaced Bob. ${marker}`,
        withEvidence("Bob replaced Alice."),
      ),
    ).toBe(false);
    expect(
      validateSharedRealtimeReply(
        `BTC rose from 100 to 200 USD. ${marker}`,
        withEvidence("BTC rose from 100 to 200 USD."),
      ),
    ).toBe(true);
    expect(
      validateSharedRealtimeReply(
        `BTC rose from 100 to 200 USD. ${marker}`,
        withEvidence("BTC rose from 200 to 100 USD."),
      ),
    ).toBe(false);
  });

  test("does not borrow unrelated negation from another evidence clause", () => {
    if (grounding.kind !== "web_search") throw new Error("fixture grounding must be available");
    const mixedGrounding: SharedRuntimePublicGrounding = {
      ...grounding,
      sourceUrls: ["https://company.example/leadership"],
      sources: [
        {
          url: "https://company.example/leadership",
          text: JSON.stringify({
            url: "https://company.example/leadership",
            excerpt: "Alice Example is the current CEO of Example Corp. Bob is not the CFO.",
          }),
        },
      ],
    };
    if (mixedGrounding.kind !== "web_search") {
      throw new Error("fixture grounding must be available");
    }
    expect(
      validateSharedRealtimeReply(
        "Alice Example is not the current CEO of Example Corp. [[SOURCE_URL:https://company.example/leadership]]",
        mixedGrounding,
      ),
    ).toBe(false);
  });

  test("reuses a preflight receipt only for its exact normalized query", async () => {
    const result = {
      success: true,
      text: "bounded evidence",
      data: { actionName: "WEB_SEARCH", query: "BTC price now" },
    };
    const runner = createMatchingRealtimeSearchRunner(result);
    await expect(runner("  btc   PRICE now ")).resolves.toBe(result);
    await expect(runner("private account balance")).resolves.toMatchObject({
      success: false,
      data: { actionName: "WEB_SEARCH", query: "private account balance" },
    });
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
