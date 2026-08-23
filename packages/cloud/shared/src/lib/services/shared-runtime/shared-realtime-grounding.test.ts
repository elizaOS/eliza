/** Deterministic adversarial coverage for Shared current-data grounding gates. */

import { describe, expect, test } from "bun:test";
import type { SharedRuntimePublicGrounding } from "../../../db/schemas/shared-runtime-history";
import {
  createMatchingRealtimeSearchRunner,
  finalizeSharedRealtimeReply,
  isSharedPublicSearchSafe,
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
    "the weather was nice yesterday",
    "tell me a joke about bitcoin price",
    "what is the score of this test?",
    "score this essay",
    "can you draft an announcement today?",
    "the weather is nice, isn't it?",
  ]) {
    test(`does not export ordinary conversation as a public search: ${message}`, () => {
      expect(resolveSharedRealtimeRequirement(message, [])).toBeUndefined();
    });
  }

  test("still recognizes explicit current public requests after conservative classification", () => {
    expect(resolveSharedRealtimeRequirement("what's the weather like in Austin?", [])?.domain).toBe(
      "weather",
    );
    expect(resolveSharedRealtimeRequirement("check the latest BTC price", [])?.domain).toBe(
      "markets",
    );
    expect(resolveSharedRealtimeRequirement("show me current NBA standings", [])?.domain).toBe(
      "sports",
    );
  });
  for (const message of [
    "check my todos",
    "can you check that for me",
    "confirm the meeting",
    "send me the link",
    "what's on my schedule today",
    "what is the status of my order",
    "what is the BTC price? contact alice@example.com",
    "check the current BTC price with this password",
  ]) {
    test(`never sends private state to public search: ${message}`, () => {
      expect(resolveSharedRealtimeRequirement(message, [])).toBeUndefined();
    });
  }

  test("never rebuilds a correction query from persisted or server-rendered history", () => {
    const history = [
      {
        role: "user" as const,
        content: "[Public guild; speaker: Alice; channel: ops] what is btc price rn",
      },
      {
        role: "assistant" as const,
        content: "Bitcoin is currently 63,800 USD according to TradingView",
      },
    ];
    expect(resolveSharedRealtimeRequirement("that's wrong, check again", history)).toBeUndefined();
    expect(resolveSharedRealtimeRequirement("check the web", history)).toBeUndefined();
    expect(
      resolveSharedRealtimeRequirement("wrong — what is the current BTC price?", history),
    ).toMatchObject({
      domain: "markets",
      query: "BTC price current",
      correction: true,
    });
  });

  for (const literal of [
    "weather at 192.168.1.1",
    "weather at 8.8.8.8",
    "weather at [::1]",
    "weather at localhost",
    "version for http://localhost/admin",
    "latest news from example.com",
    "latest news from https://example.com/current",
  ]) {
    test(`never exports a network target: ${literal}`, () => {
      expect(resolveSharedRealtimeRequirement(literal, [])).toBeUndefined();
    });
  }

  for (const literal of [
    "current BTC price; project codename zephyr",
    "current BTC price with ｐａｓｓｗｏｒｄ zephyr",
    "current BTC price with pass\u200Bword zephyr",
  ]) {
    test(`never exports appended or disguised private text: ${literal}`, () => {
      expect(resolveSharedRealtimeRequirement(literal, [])).toBeUndefined();
    });
  }

  test("constructs a narrow market query instead of exporting unrelated utterance text", () => {
    expect(resolveSharedRealtimeRequirement("please check the current BTC price", [])).toEqual({
      domain: "markets",
      query: "BTC price current",
      correction: false,
    });
  });

  test("constructs bounded stock queries without exporting appended clauses", () => {
    expect(resolveSharedRealtimeRequirement("current AAPL stock price", [])?.query).toBe(
      "AAPL stock price current",
    );
    expect(resolveSharedRealtimeRequirement("Apple share price now", [])?.query).toBe(
      "Apple stock price current",
    );
  });

  test("refuses an unscoped weather lookup rather than searching arbitrary global weather", () => {
    expect(resolveSharedRealtimeRequirement("what's the weather?", [])).toBeUndefined();
  });

  test("fresh-searches every follow-up for which history policy selects mutable grounding", () => {
    const history = [
      { role: "user" as const, content: "what is btc price rn" },
      {
        role: "assistant" as const,
        content: "BTC was 63,800 USD.",
        grounding,
      },
    ];
    for (const message of ["what about that now?", "what about that?", "BTC outlook?"]) {
      expect(resolveSharedRealtimeRequirement(message, history)).toMatchObject({
        domain: "markets",
        query: "BTC price current",
        correction: true,
      });
    }
  });

  test("keeps weather, news, and mutable canonical queries restart-safe", () => {
    for (const [query, followUp] of [
      ["current public weather in San Francisco", "what about that now?"],
      ["latest public election news", "what about that?"],
      ["current public ceo of Example Corp", "is that still current?"],
    ] as const) {
      const prior: SharedRuntimePublicGrounding = { ...grounding, query };
      expect(
        resolveSharedRealtimeRequirement(followUp, [
          { role: "user", content: query },
          { role: "assistant", content: "Old mutable claim.", grounding: prior },
        ])?.query,
      ).toBe(query);
    }
  });

  for (const literal of [
    "what is the weather at 123 Main Street?",
    "what is the weather at (415) 555-1212?",
    "what is the weather at 4155551212?",
    "what is the weather at +14155551212?",
    "what is the weather at 37.7749, -122.4194?",
    "what is the weather at 37.7749 N, 122.4194 W?",
  ]) {
    test(`rejects precise private literals from public lookup: ${literal}`, () => {
      expect(resolveSharedRealtimeRequirement(literal, [])).toBeUndefined();
    });
  }

  test("does not mistake ordinary public dates and market values for private literals", () => {
    for (const message of [
      "what was the BTC price on 2026-08-23?",
      "what is BTC market cap at 1,415,555,121.20 USD?",
      "BTC is 77,357.93 USD and gold is 3,374.19 USD",
      "compare 37.7749 USD with 122.4194 USD",
    ]) {
      expect(isSharedPublicSearchSafe(message)).toBe(true);
    }
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

  test("rejects source evidence that embeds a loopback or credential-bearing URL", () => {
    for (const unsafeUrl of ["http://127.0.0.1/admin", "https://user:pass@example.com/private"]) {
      expect(
        requireTraceableRealtimeSearch(
          {
            success: true,
            text: "bounded result",
            data: {
              actionName: "WEB_SEARCH",
              query: "service status",
              provider: "parallel",
              observedAt,
              truncated: false,
              sources: [
                {
                  url: "https://status.example.com/current",
                  text: `See ${unsafeUrl} for status.`,
                },
              ],
            },
          },
          "service status",
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

  test("binds currency, percent, temperature, speed, and length units to evidence", () => {
    const marker = "[[SOURCE_URL:https://coin.example/bitcoin]]";
    const withEvidence = (text: string): SharedRuntimePublicGrounding => ({
      ...grounding,
      sources: [{ url: "https://coin.example/bitcoin", text }],
    });
    for (const [claim, evidence] of [
      ["Asset is $77", "Asset is 77 euros"],
      ["Asset is 77 USD", "Asset is €77"],
      ["Growth is 5%", "Growth is $5"],
      ["Temperature is 20 celsius", "Temperature is 20 fahrenheit"],
      ["Wind is 10 mph", "Wind is 10 km/h"],
      ["Length is 5 inches", "Length is 5 cm"],
      ["Wind is 5 mph and distance is 10 km", "Wind is 5 km and distance is 10 mph"],
    ] as const) {
      const result = withEvidence(evidence);
      if (result.kind !== "web_search") throw new Error("fixture grounding must be available");
      expect(validateSharedRealtimeReply(`${claim}. ${marker}`, result)).toBe(false);
    }
    const equivalent = withEvidence("Asset is 77 dollars and growth is 5 percent.");
    if (equivalent.kind !== "web_search") throw new Error("fixture grounding must be available");
    expect(validateSharedRealtimeReply(`Asset is $77. ${marker}`, equivalent)).toBe(true);
    expect(validateSharedRealtimeReply(`Growth is 5%. ${marker}`, equivalent)).toBe(true);
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

  test("rejects subject-object and per-entity value swaps within one source", () => {
    if (grounding.kind !== "web_search") throw new Error("fixture grounding must be available");
    const relationGrounding: SharedRuntimePublicGrounding = {
      ...grounding,
      sourceUrls: ["https://facts.example/current"],
      sources: [
        {
          url: "https://facts.example/current",
          text: "Alice defeated Bob. BTC is 100 USD and ETH is 200 USD.",
        },
      ],
    };
    if (relationGrounding.kind !== "web_search") {
      throw new Error("fixture grounding must be available");
    }
    expect(
      validateSharedRealtimeReply(
        "Bob defeated Alice. [[SOURCE_URL:https://facts.example/current]]",
        relationGrounding,
      ),
    ).toBe(false);
    expect(
      validateSharedRealtimeReply(
        "BTC is 200 USD and ETH is 100 USD. [[SOURCE_URL:https://facts.example/current]]",
        relationGrounding,
      ),
    ).toBe(false);
  });

  test("rejects unsafe URLs in delivered claim prose instead of filtering them out", () => {
    if (grounding.kind !== "web_search") throw new Error("fixture grounding must be available");
    const source: SharedRuntimePublicGrounding = {
      ...grounding,
      sourceUrls: ["https://status.example.com/current"],
      sources: [
        {
          url: "https://status.example.com/current",
          text: "See the local admin page for status.",
        },
      ],
    };
    if (source.kind !== "web_search") throw new Error("fixture grounding must be available");
    expect(
      validateSharedRealtimeReply(
        "See http://127.0.0.1/admin for status. [[SOURCE_URL:https://status.example.com/current]]",
        source,
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
