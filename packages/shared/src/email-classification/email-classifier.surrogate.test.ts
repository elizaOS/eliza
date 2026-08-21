/**
 * Surrogate-safe snippet truncation for email classifier LLM prompt.
 * Gmail snippet capped at 800 chars for LLM prompt must not split surrogate
 * pairs. Exercises production seams formatEmailSnippet and buildLlmPrompt
 * so reverting the well-formed helpers makes the suite red.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildLlmPrompt,
  EMAIL_SNIPPET_MAX_LENGTH,
  formatEmailSnippet,
} from "./email-classifier.ts";

function isWellFormed(value: string): boolean {
  if (!value) return true;
  const maybe = value as unknown as { isWellFormed?: () => boolean };
  if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
  return toWellFormedUnicode(value) === value;
}

describe("email-classifier snippet 800 surrogate safety", () => {
  const fox = "🦊";

  it("formatEmailSnippet backs off mid-pair at 800", () => {
    const input = `${"a".repeat(799)}${fox}b`;
    const out = formatEmailSnippet(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.length).toBe(799);
    expect(out.length).toBeLessThanOrEqual(EMAIL_SNIPPET_MAX_LENGTH);
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out).not.toContain(fox);
  });

  it("formatEmailSnippet preserves fitting emoji at 800", () => {
    const input = `${"a".repeat(798)}${fox}`;
    const out = formatEmailSnippet(input);
    expect(out).toBe(input);
    expect(out.length).toBe(800);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("formatEmailSnippet sweep 0..65 offsets all well-formed at 800", () => {
    for (let off = 0; off <= 65; off++) {
      const input = `${"a".repeat(off)}${fox}${"b".repeat(900)}`;
      const out = formatEmailSnippet(input);
      expect(isWellFormed(out)).toBe(true);
      expect(out.length).toBeLessThanOrEqual(EMAIL_SNIPPET_MAX_LENGTH);
      expect(() => JSON.stringify(out)).not.toThrow();
    }
  });

  it("formatEmailSnippet sanitises lone high surrogate", () => {
    const input = `ok \ud83d ${"x".repeat(900)}`;
    const out = formatEmailSnippet(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes("\ud83d")).toBe(false);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("formatEmailSnippet sanitises lone low surrogate", () => {
    const input = `ok \udc00 ${"x".repeat(900)}`;
    const out = formatEmailSnippet(input);
    expect(isWellFormed(out)).toBe(true);
    expect(out.includes("�")).toBe(true);
    expect(out.includes("\udc00")).toBe(false);
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("formatEmailSnippet empty and short passthrough well-formed", () => {
    expect(isWellFormed(formatEmailSnippet(""))).toBe(true);
    expect(isWellFormed(formatEmailSnippet(null))).toBe(true);
    expect(isWellFormed(formatEmailSnippet(undefined))).toBe(true);
    expect(formatEmailSnippet("hello")).toBe("hello");
    expect(() => JSON.stringify(formatEmailSnippet(""))).not.toThrow();
  });

  it("buildLlmPrompt with snippet splitting emoji stays well-formed via production path", () => {
    const snippet = `${"a".repeat(799)}${fox}b`;
    const prompt = buildLlmPrompt({
      subject: "hello",
      from: "a@b.com",
      fromEmail: "a@b.com",
      snippet,
    });
    expect(isWellFormed(prompt)).toBe(true);
    expect(prompt.length).toBeGreaterThan(0);
    expect(() => JSON.stringify(prompt)).not.toThrow();
    expect(() => JSON.stringify({ prompt })).not.toThrow();
    // The prompt must not contain a lone surrogate from the cut.
    expect(prompt).not.toContain("\ud83d");
    // Production seam: explicit slice(0,800) would leave a lone high surrogate.
    const naiveSnippet = (snippet ?? "").slice(0, 800);
    expect(isWellFormed(naiveSnippet)).toBe(false);
    // But production trunc backs off, so the snippet portion is well-formed.
    const expectedSnippet = formatEmailSnippet(snippet);
    expect(prompt).toContain(`Snippet: ${expectedSnippet}`);
    expect(expectedSnippet.length).toBe(799);
  });

  it("buildLlmPrompt preserves fitting emoji via production path", () => {
    const snippet = `${"a".repeat(798)}${fox}`;
    const prompt = buildLlmPrompt({
      subject: "test",
      from: "a@b.com",
      fromEmail: "a@b.com",
      snippet,
    });
    expect(isWellFormed(prompt)).toBe(true);
    expect(() => JSON.stringify(prompt)).not.toThrow();
    expect(prompt).toContain(fox);
    expect(prompt).toContain(`Snippet: ${snippet}`);
  });

  it("buildLlmPrompt JSON no-throw with well-formed snippet", () => {
    const snippet = `${"a".repeat(10)}\ud800${"b".repeat(10)}`;
    const prompt = buildLlmPrompt({
      subject: "test",
      from: "x@y.com",
      fromEmail: "x@y.com",
      snippet,
    });
    expect(isWellFormed(prompt)).toBe(true);
    expect(prompt.includes("�")).toBe(true);
    expect(() => JSON.stringify(prompt)).not.toThrow();
    expect(() => JSON.stringify({ prompt })).not.toThrow();
  });

  it("formatEmailSnippet respects EMAIL_SNIPPET_MAX_LENGTH cap", () => {
    expect(EMAIL_SNIPPET_MAX_LENGTH).toBe(800);
    const long = "a".repeat(1200);
    const out = formatEmailSnippet(long);
    expect(out.length).toBe(800);
    expect(isWellFormed(out)).toBe(true);
    expect(() => JSON.stringify(out)).not.toThrow();
  });
});
