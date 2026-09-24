/**
 * Surrogate-safe truncation for dev-settings table helpers.
 * Verifies truncateCell, boxTopRule, boxRow never split surrogate pairs and sanitize lone surrogates.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { boxRow, boxTopRule, truncateCell } from "./dev-settings-table";

describe("dev-settings-table surrogate safety", () => {
  const isWellFormed = (s: string): boolean => {
    const w = s as unknown as { isWellFormed?: () => boolean };
    if (typeof w.isWellFormed === "function") return w.isWellFormed();
    return toWellFormedUnicode(s) === s;
  };

  describe("truncateCell", () => {
    it("backs off when truncation would split a surrogate pair", () => {
      const input = `${"a".repeat(15)}🦊${"b".repeat(20)}`;
      const out = truncateCell(input, 16);
      expect(isWellFormed(out)).toBe(true);
      expect(out.endsWith("…")).toBe(true);
      expect(out.length).toBeLessThanOrEqual(16);
      expect(() => JSON.stringify(out)).not.toThrow();
    });

    it("preserves fitting emoji", () => {
      const input = `${"a".repeat(14)}🦊`;
      const out = truncateCell(input, 16);
      expect(isWellFormed(out)).toBe(true);
      expect(out).toBe(toWellFormedUnicode(input));
    });

    it("sanitizes lone high surrogate", () => {
      const input = `ok \ud800 end ${"x".repeat(50)}`;
      const out = truncateCell(input, 16);
      expect(isWellFormed(out)).toBe(true);
      expect(out.includes("�")).toBe(true);
    });

    it("sanitizes lone low surrogate", () => {
      const input = `ok \udc00 end ${"x".repeat(50)}`;
      const out = truncateCell(input, 16);
      expect(isWellFormed(out)).toBe(true);
      expect(out.includes("�")).toBe(true);
    });

    it("handles maxWidth <2 without splitting", () => {
      const input = "😀ab";
      const out1 = truncateCell(input, 1);
      const out0 = truncateCell(input, 0);
      expect(isWellFormed(out1)).toBe(true);
      expect(isWellFormed(out0)).toBe(true);
      expect(out1.length).toBeLessThanOrEqual(1);
      expect(out0).toBe("");
    });
  });

  describe("boxTopRule", () => {
    it("backs off when title truncation would split surrogate at outer", () => {
      const title = `${"a".repeat(20)}🦊${"b".repeat(20)}`;
      const out = boxTopRule(title, 24);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    });

    it("sanitizes lone surrogate in title", () => {
      const title = `ok \ud800 end ${"x".repeat(50)}`;
      const out = boxTopRule(title, 30);
      expect(isWellFormed(out)).toBe(true);
      expect(out.includes("�") || isWellFormed(out)).toBe(true);
    });

    it("handles inner<4 branch without splitting (outer=3)", () => {
      const title = "😀ab";
      const out = boxTopRule(title, 3);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(3);
    });
  });

  describe("boxRow", () => {
    it("backs off when line truncation would split surrogate", () => {
      const line = `${"a".repeat(30)}🦊${"b".repeat(20)}`;
      const out = boxRow(line, 40);
      expect(isWellFormed(out)).toBe(true);
      expect(() => JSON.stringify(out)).not.toThrow();
    });

    it("sanitizes lone surrogate", () => {
      const line = `ok \ud800 end ${"x".repeat(50)}`;
      const out = boxRow(line, 40);
      expect(isWellFormed(out)).toBe(true);
      expect(out.includes("�") || isWellFormed(out)).toBe(true);
    });

    it("preserves under-cap well-formed line", () => {
      const line = `${"a".repeat(5)}🦊`;
      const out = boxRow(line, 80);
      expect(isWellFormed(out)).toBe(true);
    });
  });

  describe("sweep", () => {
    it("stays well-formed across offsets for truncateCell", () => {
      for (let offset = 0; offset <= 20; offset++) {
        const input = `${"a".repeat(offset)}🦊${"b".repeat(50)}`;
        const out = truncateCell(input, 16);
        expect(isWellFormed(out)).toBe(true);
        expect(out.length).toBeLessThanOrEqual(16);
      }
    });
  });
});
