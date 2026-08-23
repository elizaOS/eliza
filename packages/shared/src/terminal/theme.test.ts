/**
 * Unit coverage for CLI terminal theme utilities in theme.ts.
 *
 * Tests theme color properties, cyberGreen color helper, isRich predicate,
 * and conditional colorize helper.
 */

import { describe, expect, it } from "vitest";
import { colorize, cyberGreen, isRich, theme } from "./theme.js";

describe("terminal theme", () => {
  it("exports theme with all required palette functions", () => {
    expect(typeof theme.accent).toBe("function");
    expect(typeof theme.accentBright).toBe("function");
    expect(typeof theme.accentDim).toBe("function");
    expect(typeof theme.info).toBe("function");
    expect(typeof theme.success).toBe("function");
    expect(typeof theme.warn).toBe("function");
    expect(typeof theme.error).toBe("function");
    expect(typeof theme.muted).toBe("function");
    expect(typeof theme.heading).toBe("function");
    expect(typeof theme.command).toBe("function");
    expect(typeof theme.option).toBe("function");
  });

  it("applies theme formatting to text without throwing", () => {
    const text = "sample message";
    expect(theme.accent(text)).toBeDefined();
    expect(theme.info(text)).toBeDefined();
    expect(theme.heading(text)).toBeDefined();
  });

  it("exports cyberGreen color function", () => {
    expect(typeof cyberGreen).toBe("function");
    expect(cyberGreen("matrix")).toBeDefined();
  });

  it("evaluates isRich boolean predicate", () => {
    const rich = isRich();
    expect(typeof rich).toBe("boolean");
  });

  describe("colorize", () => {
    it("returns colored string when rich is true", () => {
      const mockFormatter = (val: string) => `[colored]${val}[/colored]`;
      const result = colorize(true, mockFormatter, "hello");
      expect(result).toBe("[colored]hello[/colored]");
    });

    it("returns plain string untouched when rich is false", () => {
      const mockFormatter = (val: string) => `[colored]${val}[/colored]`;
      const result = colorize(false, mockFormatter, "hello");
      expect(result).toBe("hello");
    });
  });
});
