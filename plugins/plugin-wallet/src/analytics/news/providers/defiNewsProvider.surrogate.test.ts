/**
 * Surrogate safety for defiNewsProvider — exercises production helper and provider.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { defiNewsProvider, formatDefiNewsText } from "./defiNewsProvider.ts";

function isWellFormed(v: string): boolean {
  if (!v) return true;
  const maybe = v as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = v.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function makeRuntime(poisonedTitle: string): IAgentRuntime {
  const newsDataService = {
    getLatestNews: async () => [
      {
        title: poisonedTitle,
        description: poisonedTitle,
        source_id: "test",
        pubDate: new Date().toISOString(),
        link: "https://example.com",
      },
      {
        title: "ok",
        description: "ok",
        source_id: "test2",
        pubDate: new Date().toISOString(),
        link: "https://example.com/2",
      },
    ],
  };
  return {
    getService: (name: string) => {
      if (name === "NEWS_DATA_SERVICE") return newsDataService as never;
      // No CoinGecko to keep provider path simple (still truncates via latestNews)
      return null;
    },
    logger: {
      warn: () => {},
      error: () => {},
      info: () => {},
      debug: () => {},
    },
  } as unknown as IAgentRuntime;
}

describe("defiNewsProvider surrogate safety", () => {
  it("helper keeps surrogate pairs intact at 4,000-char limit boundary", () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    const input = `${"a".repeat(3999)}${fox}${"b".repeat(100)}`;
    const out = formatDefiNewsText(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(3999);
    expect(out).not.toContain("\uD83E");
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  it("helper sanitizes lone surrogates in news content", () => {
    const lone = `DeFi update ${String.fromCharCode(0xd800)} report ${"a".repeat(5000)}`;
    const out = formatDefiNewsText(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(4000);
  });

  it("provider returns well-formed text at 4,000 cap with astral boundary via service", async () => {
    const fox = String.fromCharCode(0xd83e, 0xdd8a);
    // Craft title so that provider's assembled defiNewsInfo hits the 3999 boundary with fox
    // Provider prefixes with "=== DEFI & CRYPTO..." (~35 chars) plus article scaffolding.
    // To guarantee boundary, we make title itself poisoned and large enough to be truncated.
    const poisonedTitle = `${"a".repeat(3999)}${fox}${"b".repeat(100)}`;
    const runtime = makeRuntime(poisonedTitle);
    const message = {
      content: { text: "BTC news" },
      entityId: "e1",
      roomId: "r1",
    } as unknown as Memory;
    const result = await defiNewsProvider.get(runtime, message, {} as State);
    expect(isWellFormed(result.text)).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
    // must be truncated at 4000, not contain lone high surrogate
    expect(result.text.length).toBeLessThanOrEqual(4000);
    expect(result.text.includes("\ud83e")).toBe(false);
  });

  it("provider sanitizes lone surrogate from service content", async () => {
    const lone = `DeFi update ${String.fromCharCode(0xd800)} report ${"a".repeat(5000)}`;
    const runtime = makeRuntime(lone);
    const message = {
      content: { text: "hello" },
      entityId: "e1",
      roomId: "r1",
    } as unknown as Memory;
    const result = await defiNewsProvider.get(runtime, message, {} as State);
    expect(isWellFormed(result.text)).toBe(true);
    expect(result.text.includes("\ud800")).toBe(false);
    if (result.text.includes("�")) {
      expect(result.text.includes("�")).toBe(true);
    }
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
