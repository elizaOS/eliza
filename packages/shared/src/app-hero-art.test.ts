/**
 * Unit tests for app hero artwork generation and theme derivation.
 */

import { describe, expect, it } from "vitest";
import {
  createGeneratedAppHeroDataUrl,
  createGeneratedAppHeroSvg,
  getAppHeroDisplayLabel,
  getAppHeroMonogram,
  getAppHeroThemeKey,
} from "./app-hero-art.js";

describe("app-hero-art", () => {
  it("derives clean display labels stripped of package and plugin prefixes", () => {
    expect(getAppHeroDisplayLabel({ name: "@elizaos/plugin-weather" })).toBe(
      "weather",
    );
    expect(getAppHeroDisplayLabel({ name: "app-dashboard" })).toBe("dashboard");
    expect(
      getAppHeroDisplayLabel({
        name: "plugin-calculator",
        displayName: "Calculator Tool",
      }),
    ).toBe("Calculator Tool");
  });

  it("extracts 2-character uppercase monograms from app name or display name", () => {
    expect(getAppHeroMonogram({ name: "Task Tracker" })).toBe("TT");
    expect(getAppHeroMonogram({ name: "Single" })).toBe("S");
    expect(getAppHeroMonogram({ name: "@elizaos/plugin-crypto-swap" })).toBe(
      "CS",
    );
    expect(getAppHeroMonogram({ name: "" })).toBe("?");
  });

  it("categorizes apps into appropriate theme keys", () => {
    expect(getAppHeroThemeKey({ name: "arcade-game", category: "games" })).toBe(
      "play",
    );
    expect(
      getAppHeroThemeKey({
        name: "companion-chat",
        description: "Social DM bot",
      }),
    ).toBe("chat");
    expect(
      getAppHeroThemeKey({
        name: "crypto-wallet",
        description: "Finance tool",
      }),
    ).toBe("money");
    expect(
      getAppHeroThemeKey({ name: "db-viewer", category: "developer" }),
    ).toBe("tools");
    expect(
      getAppHeroThemeKey({ name: "browser-agent", description: "Web access" }),
    ).toBe("world");
    expect(
      getAppHeroThemeKey({ name: "task-calendar", category: "productivity" }),
    ).toBe("ops");
    expect(getAppHeroThemeKey({ name: "random-something-unmatched" })).toBe(
      "app",
    );
  });

  it("generates well-formed SVG artwork containing title and SVG structure", () => {
    const svg = createGeneratedAppHeroSvg({
      name: "test-app",
      displayName: "Test Application",
    });

    expect(svg).toContain("<svg xmlns=");
    expect(svg).toContain("<title>Test Application</title>");
    expect(svg).toContain("</svg>");
  });

  it("generates encoded data URI formatted SVG string", () => {
    const dataUrl = createGeneratedAppHeroDataUrl({
      name: "data-url-app",
      displayName: "Data Url App",
    });

    expect(dataUrl.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
    expect(dataUrl).toContain(
      encodeURIComponent("<title>Data Url App</title>"),
    );
  });
});
