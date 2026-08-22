/**
 * Exercises the agent HTTP boundary's assistant-text cleanup without replacing
 * or clipping complete long responses.
 */
import { describe, expect, it } from "vitest";
import { stripAssistantStageDirections } from "./chat-text-helpers.ts";

describe("stripAssistantStageDirections", () => {
  it("preserves complete text beyond the former 100k boundary", () => {
    const text = `${"complete line\n".repeat(9_000)}final line`;
    expect(text.length).toBeGreaterThan(100_000);
    expect(stripAssistantStageDirections(text)).toBe(text);
  });
});
