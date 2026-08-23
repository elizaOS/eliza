/**
 * Unit coverage for plain-text dev settings banner tables in dev-settings-table.ts.
 *
 * Exercises cell truncation, word-wrapping, Unicode box drawing (top/mid/bottom rules,
 * framed rows), narrow layout (framed & unframed), and wide tabular layouts.
 */

import { describe, expect, it } from "vitest";
import {
  boxRow,
  boxTopRule,
  type DevSettingsRow,
  formatDevSettingsTable,
  formatDevSettingsTableNarrow,
  truncateCell,
  wrapToWidth,
} from "./dev-settings-table.js";

describe("dev-settings-table", () => {
  describe("truncateCell", () => {
    it("returns short strings unchanged", () => {
      expect(truncateCell("hello", 10)).toBe("hello");
      expect(truncateCell("test", 4)).toBe("test");
    });

    it("truncates long strings with ellipsis", () => {
      expect(truncateCell("abcdefghijk", 5)).toBe("abcd…");
    });

    it("handles small maxWidth without ellipsis", () => {
      expect(truncateCell("abcdef", 1)).toBe("a");
      expect(truncateCell("abcdef", 0)).toBe("");
    });
  });

  describe("wrapToWidth", () => {
    it("returns original text when width < 1", () => {
      expect(wrapToWidth("sample", 0)).toEqual(["sample"]);
    });

    it("handles empty or whitespace strings", () => {
      expect(wrapToWidth("", 10)).toEqual([""]);
      expect(wrapToWidth("   ", 10)).toEqual([""]);
    });

    it("wraps words at space boundaries", () => {
      const text = "quick brown fox jumps over lazy dog";
      const wrapped = wrapToWidth(text, 12);
      expect(wrapped).toEqual(["quick brown", "fox jumps", "over lazy", "dog"]);
    });

    it("hard-breaks tokens longer than width", () => {
      const longToken = "abcdefghijklmnop";
      const wrapped = wrapToWidth(longToken, 5);
      expect(wrapped).toEqual(["abcde", "fghij", "klmno", "p"]);
    });
  });

  describe("box drawing", () => {
    it("generates centered box top rule with title", () => {
      const top = boxTopRule("API", 20);
      expect(top.startsWith("╭")).toBe(true);
      expect(top.endsWith("╮")).toBe(true);
      expect(top).toContain(" API ");
    });

    it("generates framed row with proper padding", () => {
      const row = boxRow("Status: OK", 30);
      expect(row.startsWith("│")).toBe(true);
      expect(row.endsWith("│")).toBe(true);
      expect(row).toContain("Status: OK");
    });
  });

  describe("formatDevSettingsTableNarrow", () => {
    const sampleRows: DevSettingsRow[] = [
      {
        setting: "ELIZA_PORT",
        effective: "3000",
        source: "env (ELIZA_PORT)",
        change: "Set via export ELIZA_PORT=3000",
      },
    ];

    it("formats framed narrow table with Unicode border", () => {
      const formatted = formatDevSettingsTableNarrow(
        "App Server",
        sampleRows,
        60,
        true,
      );
      expect(formatted).toContain("╭");
      expect(formatted).toContain("App Server");
      expect(formatted).toContain("ELIZA_PORT");
      expect(formatted).toContain("Effective: 3000");
      expect(formatted).toContain("╰");
    });

    it("formats unframed narrow table with plain headers", () => {
      const formatted = formatDevSettingsTableNarrow(
        "App Server",
        sampleRows,
        60,
        false,
      );
      expect(formatted).toContain("=== App Server ===");
      expect(formatted).toContain("ELIZA_PORT");
      expect(formatted).toContain("Effective: 3000");
      expect(formatted).not.toContain("╭");
    });
  });

  describe("formatDevSettingsTable", () => {
    const rows: DevSettingsRow[] = [
      {
        setting: "ELIZA_API_BIND",
        effective: "127.0.0.1",
        source: "default",
        change: "export ELIZA_API_BIND=0.0.0.0",
      },
    ];

    it("defaults to narrow layout", () => {
      const formatted = formatDevSettingsTable("Dev Banner", rows);
      expect(formatted).toContain("Dev Banner");
      expect(formatted).toContain("ELIZA_API_BIND");
    });

    it("formats wide layout with table headers when requested", () => {
      const formatted = formatDevSettingsTable("Dev Banner", rows, {
        layout: "wide",
      });
      expect(formatted).toContain("=== Dev Banner ===");
      expect(formatted).toContain("Setting");
      expect(formatted).toContain("Effective");
      expect(formatted).toContain("Source");
      expect(formatted).toContain("Change");
      expect(formatted).toContain("127.0.0.1");
    });
  });
});
