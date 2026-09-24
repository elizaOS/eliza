/**
 * Regression for BugReportModal strip surrogate safety + tag stripping.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { stripBugReportField } from "./BugReportModal";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

describe("stripBugReportField well-formed", () => {
  it("keeps surrogate pairs intact at 10k boundary", () => {
    const fox = "🦊";
    const text = `${"a".repeat(9999)}${fox}${"b".repeat(20)}`;
    const out = stripBugReportField(text, 10_000);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out).toBe("a".repeat(9999));
  });

  it("preserves fitting emoji under cap and strips tags", () => {
    const fox = "🦊";
    const text = `${"a".repeat(100)}${fox} <b>hi</b>`;
    const out = stripBugReportField(text, 10_000);
    expect(out).toContain(fox);
    expect(out).not.toContain("<b>");
    expect(isWellFormed(out)).toBe(true);
  });

  it("caps at 200 boundary for environment field with fox", () => {
    const fox = "🦊";
    const text = `${"a".repeat(199)}${fox}${"b".repeat(20)}`;
    const out = stripBugReportField(text, 200);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toBe("a".repeat(199));
  });

  it("sanitizes lone high surrogate before truncation", () => {
    const lone = `msg ${String.fromCharCode(0xd800)} ${"x".repeat(11_000)}`;
    const out = stripBugReportField(lone, 10_000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes(String.fromCharCode(0xd800))).toBe(false);
  });

  it("sanitizes lone low surrogate before truncation", () => {
    const lone = `msg ${String.fromCharCode(0xdc00)} ${"x".repeat(11_000)}`;
    const out = stripBugReportField(lone, 10_000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
  });

  it("strips nested tags and stays well-formed", () => {
    const fox = "🦊";
    const text = `<div>${"a".repeat(50)}${fox}</div><scr<script>ipt>alert(1)</scr<script>ipt>`;
    const out = stripBugReportField(text, 10_000);
    expect(out).not.toContain("<div>");
    expect(out).not.toContain("</div>");
    expect(out).not.toContain("<script>");
    expect(isWellFormed(out)).toBe(true);
    expect(out).toContain(fox);
  });

  it("sweep 0..30 offsets at 200 all well-formed", () => {
    const fox = "🦊";
    for (let n = 0; n <= 30; n++) {
      const text = `${"a".repeat(n)}${fox}${"b".repeat(500)}`;
      const out = stripBugReportField(text, 200);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(200);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });

  it("sweep at 10k with lone surrogate in input stays well-formed", () => {
    for (let n = 0; n <= 30; n++) {
      const text = `${"a".repeat(n)}${String.fromCharCode(0xd800)}${"b".repeat(11_000)}`;
      const out = stripBugReportField(text, 10_000);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(10_000);
    }
  });

  it("caps at 50k for logs with fox boundary", () => {
    const fox = "🦊";
    const text = `${"a".repeat(49_999)}${fox}${"b".repeat(20)}`;
    const out = stripBugReportField(text, 50_000);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(50_000);
    expect(out).toBe("a".repeat(49_999));
  });
});
