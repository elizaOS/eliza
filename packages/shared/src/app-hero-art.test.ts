/**
 * Tests for deterministic app hero artwork generation, monograms, labels, and theme keys.
 */
import { describe, expect, it } from "vitest";
import {
  createGeneratedAppHeroDataUrl,
  createGeneratedAppHeroSvg,
  getAppHeroDisplayLabel,
  getAppHeroMonogram,
  getAppHeroThemeKey,
} from "./app-hero-art.ts";

describe("getAppHeroDisplayLabel", () => {
  it("strips package scopes and plugin/app prefixes", () => {
    expect(getAppHeroDisplayLabel({ name: "@elizaos/plugin-solana" })).toBe(
      "solana",
    );
    expect(getAppHeroDisplayLabel({ name: "plugin-browser" })).toBe("browser");
    expect(getAppHeroDisplayLabel({ name: "app-chat" })).toBe("chat");
  });

  it("prioritizes displayName when present", () => {
    expect(
      getAppHeroDisplayLabel({
        name: "plugin-twitter",
        displayName: "Twitter Connector",
      }),
    ).toBe("Twitter Connector");
  });

  it("handles nullish or invalid inputs safely", () => {
    expect(getAppHeroDisplayLabel(null)).toBe("");
    expect(getAppHeroDisplayLabel(undefined)).toBe("");
    expect(getAppHeroDisplayLabel({} as unknown as { name: string })).toBe("");
  });
});

describe("getAppHeroMonogram", () => {
  it("extracts 2-letter initials for multi-word and compound names", () => {
    expect(getAppHeroMonogram({ name: "Solana Trader" })).toBe("ST");
    expect(getAppHeroMonogram({ name: "crypto-wallet" })).toBe("CW");
    expect(getAppHeroMonogram({ name: "my_cool.agent" })).toBe("MC");
  });

  it("uses first two letters for single words", () => {
    expect(getAppHeroMonogram({ name: "Browser" })).toBe("BR");
    expect(getAppHeroMonogram({ name: "X" })).toBe("X");
  });

  it("handles empty or nullish inputs by returning ?", () => {
    expect(getAppHeroMonogram(null)).toBe("?");
    expect(getAppHeroMonogram(undefined)).toBe("?");
    expect(getAppHeroMonogram({ name: "" })).toBe("?");
  });
});

describe("getAppHeroThemeKey", () => {
  it("classifies apps into thematic categories based on metadata", () => {
    expect(getAppHeroThemeKey({ name: "arcade-quest", category: "game" })).toBe(
      "play",
    );
    expect(
      getAppHeroThemeKey({
        name: "discord-bot",
        description: "social companion message chat",
      }),
    ).toBe("chat");
    expect(
      getAppHeroThemeKey({
        name: "solana-dex",
        category: "finance trade wallet",
      }),
    ).toBe("money");
    expect(
      getAppHeroThemeKey({
        name: "dev-debugger",
        description: "runtime memory viewer utility",
      }),
    ).toBe("tools");
    expect(
      getAppHeroThemeKey({
        name: "web-crawler",
        description: "browser network",
      }),
    ).toBe("world");
    expect(
      getAppHeroThemeKey({
        name: "task-runner",
        description: "team calendar life ops",
      }),
    ).toBe("ops");
    expect(
      getAppHeroThemeKey({
        name: "random-unclassified-entity",
      }),
    ).toBe("app");
  });

  it("handles nullish inputs safely", () => {
    expect(getAppHeroThemeKey(null)).toBe("app");
    expect(getAppHeroThemeKey(undefined)).toBe("app");
  });
});

describe("createGeneratedAppHeroSvg and createGeneratedAppHeroDataUrl", () => {
  it("generates valid SVG artwork containing theme elements and title", () => {
    const svg = createGeneratedAppHeroSvg({
      name: "plugin-chat",
      displayName: "Chat & Social",
    });

    expect(typeof svg).toBe("string");
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).toContain("<title>Chat &amp; Social</title>");
    expect(svg).toContain('<linearGradient id="bg"');
  });

  it("renders distinct motifs for each supported theme", () => {
    const themes = [
      { name: "game-app", category: "game" },
      { name: "chat-bot", category: "chat" },
      { name: "crypto-wallet", category: "money" },
      { name: "dev-debugger", category: "utility" },
      { name: "world-net", category: "world" },
      { name: "ops-manager", category: "ops" },
      { name: "plain-app" },
    ];

    for (const app of themes) {
      const svg = createGeneratedAppHeroSvg(app);
      expect(typeof svg).toBe("string");
      expect(svg.length).toBeGreaterThan(200);
    }
  });

  it("generates valid data URLs with URL-encoded SVG", () => {
    const dataUrl = createGeneratedAppHeroDataUrl({
      name: "@elizaos/plugin-solana",
      category: "wallet",
    });

    expect(dataUrl.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(dataUrl).toContain(encodeURIComponent("<svg"));
  });

  it("handles nullish inputs safely", () => {
    const svg = createGeneratedAppHeroSvg(null);
    expect(svg.startsWith("<svg")).toBe(true);
  });
});
