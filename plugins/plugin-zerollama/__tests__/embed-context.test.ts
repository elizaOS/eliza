/**
 * Surrogate-aware truncation for Ollama embedding inputs. A blind
 * slice(0, maxChars) that lands mid-emoji leaves a lone high surrogate;
 * JSON.stringify emits it as \uD83E and Ollama's strict JSON rejects it.
 * truncateEmbedInput must sanitize lone surrogates and never split pairs
 * for both string and string[] inputs.
 */
import { describe, expect, it } from "vitest";
import { truncateEmbedInput } from "../utils/embed-context.ts";

describe("truncateEmbedInput — surrogate-aware truncation", () => {
  it("keeps UTF-16 surrogate pairs intact at the string boundary", () => {
    const text = `${"a".repeat(9)}🦊${"b".repeat(100)}`;
    const truncated = truncateEmbedInput(text, 10) as string;
    expect(truncated.isWellFormed()).toBe(true);
    expect(truncated.length).toBeLessThanOrEqual(10);
    expect(truncated).toBe("a".repeat(9));
  });

  it("preserves a fitting emoji under the cap", () => {
    const text = `${"a".repeat(8)}🦊`;
    const truncated = truncateEmbedInput(text, 10) as string;
    expect(truncated).toBe(text);
    expect(truncated.isWellFormed()).toBe(true);
    expect(truncated.length).toBe(10);
  });

  it("sanitizes lone surrogates in string input before truncating", () => {
    const text = "a\ud800bcdef";
    const truncated = truncateEmbedInput(text, 4) as string;
    expect(truncated).toBe("a\ufffdbc");
    expect(truncated.isWellFormed()).toBe(true);
  });

  it("sanitizes lone surrogates without truncation when under the cap", () => {
    const text = "a\ud800bc";
    const out = truncateEmbedInput(text, 10) as string;
    expect(out).toBe("a\ufffdbc");
    expect(out.isWellFormed()).toBe(true);
  });

  it("keeps surrogate pairs intact for string[] inputs", () => {
    const input = [`${"a".repeat(9)}🦊tail`, "short", "a\ud800bc"];
    const out = truncateEmbedInput(input, 10) as string[];
    expect(out[0].isWellFormed()).toBe(true);
    expect(out[0].length).toBeLessThanOrEqual(10);
    expect(out[0]).toBe("a".repeat(9));
    expect(out[1]).toBe("short");
    expect(out[2]).toBe("a\ufffdbc");
    expect(out[2].isWellFormed()).toBe(true);
  });

  it("returns empty string when maxChars is 0", () => {
    expect(truncateEmbedInput("hello", 0)).toBe("");
    expect((truncateEmbedInput("hello", 0) as string).isWellFormed()).toBe(true);
  });
});
