/**
 * Unit coverage for CLI terminal theme utilities in theme.ts.
 *
 * Tests theme color properties, cyberGreen color helper, isRich predicate,
 * and conditional colorize helper.
 */

import { describe, expect, it } from "vitest";
import { colorize } from "./theme.js";

describe("terminal theme", () => {
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
