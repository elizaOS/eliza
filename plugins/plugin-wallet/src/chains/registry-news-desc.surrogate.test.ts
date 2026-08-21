/**
 * Regression for PumpPortal failure detail and news article description surrogate safety.
 * Drives production helpers formatPumpPortalErrorDetail, formatArticleDescription, and
 * formatDefiNewsText — reverting any helper to naive slice/substring reintroduces lone
 * surrogates and makes the suite red.
 */

import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  defiNewsProvider,
  formatArticleDescription,
  formatDefiNewsText,
} from "../analytics/news/providers/defiNewsProvider";
import { formatPumpPortalErrorDetail } from "./registry";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = value.charCodeAt(i + 1);
      if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
  }
  return true;
}

function makeRuntime(poisonedText: string): IAgentRuntime {
  const newsDataService = {
    getLatestNews: async () => [
      {
        title: poisonedText,
        description: poisonedText,
        source_id: "test",
        pubDate: new Date().toISOString(),
        link: "https://example.com",
      },
    ],
  };
  return {
    getService: (name: string) => {
      if (name === "NEWS_DATA_SERVICE") return newsDataService as never;
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

function makeRuntimeWithDesc(
  title: string,
  description: string,
): IAgentRuntime {
  const newsDataService = {
    getLatestNews: async () => [
      {
        title,
        description,
        source_id: "test",
        pubDate: new Date().toISOString(),
        link: "https://example.com",
      },
    ],
  };
  return {
    getService: (name: string) => {
      if (name === "NEWS_DATA_SERVICE") return newsDataService as never;
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

describe("wallet PumpPortal and news description surrogate safety (production seams)", () => {
  const fox = String.fromCharCode(0xd83e, 0xdd8a);

  it("formatPumpPortalErrorDetail keeps surrogate pairs intact at 240-char boundary", () => {
    const input = `${"p".repeat(239)}${fox}${"q".repeat(50)}`;
    const out = formatPumpPortalErrorDetail(input);
    expect(isWellFormed(out)).toBe(true);
    expect(
      isWellFormed(out) &&
        (out as unknown as { isWellFormed: () => boolean }).isWellFormed?.(),
    ).not.toBe(false);
    // ": " prefix + 239 chars backs off the emoji
    expect(out.length).toBe(2 + 239);
    expect(out).not.toContain("\uD83E");
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  it("formatPumpPortalErrorDetail preserves fitting emoji under cap", () => {
    const input = `${"p".repeat(238)}${fox}`;
    const out = formatPumpPortalErrorDetail(input);
    expect(out).toBe(`: ${input}`);
    expect(isWellFormed(out)).toBe(true);
  });

  it("formatPumpPortalErrorDetail sanitizes lone surrogates", () => {
    const lone = `detail ${String.fromCharCode(0xd800)} report ${"x".repeat(300)}`;
    const out = formatPumpPortalErrorDetail(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(2 + 240);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  it("formatPumpPortalErrorDetail returns empty for empty input", () => {
    expect(formatPumpPortalErrorDetail("")).toBe("");
  });

  it("formatArticleDescription keeps surrogate pairs intact at 97-char boundary", () => {
    const input = `${"a".repeat(96)}${fox}${"b".repeat(50)}`;
    const out = formatArticleDescription(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.endsWith("...")).toBe(true);
    expect(out.length).toBe(96 + 3);
    expect(out).not.toContain("\uD83E");
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  it("formatArticleDescription preserves fitting emoji under cap", () => {
    const input = `${"a".repeat(98)}${fox}`;
    expect(formatArticleDescription(input)).toBe(input);
    const boundary = `${"a".repeat(99)}${fox}`;
    // 99 + 2 = 101 -> triggers 97 trunc, so should back off
    const out = formatArticleDescription(boundary);
    expect(isWellFormed(out)).toBe(true);
  });

  it("formatArticleDescription sanitizes lone surrogates", () => {
    const lone = `Breaking ${String.fromCharCode(0xd800)} details ${"m".repeat(200)}`;
    const out = formatArticleDescription(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it("formatArticleDescription sweep 0..65 at 97 boundary all well-formed", () => {
    for (let off = 0; off <= 65; off++) {
      const input = `${"a".repeat(off)}${fox}${"b".repeat(200)}`;
      const out = formatArticleDescription(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(100);
      expect(() => JSON.stringify({ out })).not.toThrow();
    }
  });

  it("formatDefiNewsText keeps surrogate pairs intact at 4000-char boundary", () => {
    const input = `${"a".repeat(3999)}${fox}${"b".repeat(100)}`;
    // 3999 + 2 = 4001 > 4000, so truncate backs off the fox
    const out = formatDefiNewsText(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(out).not.toContain(fox);
    expect(out).not.toContain("\uD83E");
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  it("formatDefiNewsText preserves fitting emoji under 4000 cap", () => {
    const input = `${"a".repeat(3997)}${fox}`;
    const out = formatDefiNewsText(input);
    expect(isWellFormed(out)).toBe(true);
    // input + "\n" = 3999 + 1? actually 3997 +2 +1 =4000 fits
    expect(out.includes(fox)).toBe(true);
  });

  it("formatDefiNewsText sanitizes lone surrogates", () => {
    const lone = `DeFi update ${String.fromCharCode(0xd800)} report ${"a".repeat(5000)}`;
    const out = formatDefiNewsText(lone);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(() => JSON.stringify({ out })).not.toThrow();
  });

  it("formatDefiNewsText sweep at 4000 boundary is well-formed", () => {
    for (let off = 0; off <= 30; off++) {
      const input = `${"a".repeat(off)}${fox}${"b".repeat(5000)}`;
      const out = formatDefiNewsText(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(4000);
    }
  });

  it("defiNewsProvider.get returns well-formed text at 4000 cap via poisoned service (proves provider consumes formatDefiNewsText)", async () => {
    const poisoned = `${"a".repeat(3999)}${fox}${"b".repeat(100)}`;
    const runtime = makeRuntime(poisoned);
    const message = {
      content: { text: "BTC news" },
      entityId: "e1",
      roomId: "r1",
    } as unknown as Memory;
    const result = await defiNewsProvider.get(runtime, message, {} as State);
    expect(isWellFormed(result.text)).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(4000);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("defiNewsProvider.get sanitizes lone surrogate from article description via poisoned service (proves article path is wired)", async () => {
    const lone = `Breaking ${String.fromCharCode(0xd800)} news ${"x".repeat(300)}`;
    const runtime = makeRuntime(lone);
    const message = {
      content: { text: "hello" },
      entityId: "e1",
      roomId: "r1",
    } as unknown as Memory;
    const result = await defiNewsProvider.get(runtime, message, {} as State);
    expect(isWellFormed(result.text)).toBe(true);
    expect(result.text.includes("\uD800")).toBe(false);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it("defiNewsProvider article truncation at 97 boundary is well-formed via provider path", async () => {
    const poisonedDesc = `${"a".repeat(96)}${fox}${"b".repeat(50)}`;
    const runtime = makeRuntimeWithDesc("ok title", poisonedDesc);
    const message = {
      content: { text: "news" },
      entityId: "e1",
      roomId: "r1",
    } as unknown as Memory;
    const result = await defiNewsProvider.get(runtime, message, {} as State);
    expect(isWellFormed(result.text)).toBe(true);
    // article description should have been truncated well-formed, not leave lone surrogate
    expect(() => JSON.stringify(result)).not.toThrow();
  });
});
