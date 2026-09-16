/**
 * Pure-helper test for v1/messages/route.ts's `messagesEffectiveMaxTokens`.
 *
 * The Anthropic-compatible route must preserve the caller-authored output and
 * spend ceiling even when hidden reasoning or extended thinking is active.
 */

import { describe, expect, test } from "bun:test";

import { messagesEffectiveMaxTokens } from "../v1/messages/route";

describe("messagesEffectiveMaxTokens", () => {
  test("non-reasoning model: requested budget passes through unchanged", () => {
    expect(messagesEffectiveMaxTokens(256, null, "openai/gpt-4o-mini")).toBe(
      256,
    );
    expect(
      messagesEffectiveMaxTokens(undefined, null, "openai/gpt-4o-mini"),
    ).toBeUndefined();
  });

  test("reasoning model: preserves a small or absent caller ceiling", () => {
    expect(messagesEffectiveMaxTokens(256, null, "gpt-oss-120b")).toBe(256);
    expect(
      messagesEffectiveMaxTokens(undefined, null, "gemma-4-31b"),
    ).toBeUndefined();
  });

  test("cerebras reasoning model: a larger requested budget is honored", () => {
    expect(messagesEffectiveMaxTokens(8000, null, "gpt-oss-120b")).toBe(8000);
  });

  test("Anthropic CoT: never raises the caller's ceiling", () => {
    expect(messagesEffectiveMaxTokens(1000, 10000, "anthropic/claude-x")).toBe(
      1000,
    );
  });
});
