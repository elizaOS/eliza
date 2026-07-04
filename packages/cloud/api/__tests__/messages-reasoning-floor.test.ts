/**
 * Pure-helper test for v1/messages/route.ts's `messagesEffectiveMaxTokens`.
 *
 * /v1/messages (the anthropic-proxy / eliza-code path) previously set the output
 * budget to `request.max_tokens` with no floor for cerebras reasoning models —
 * so a small max_tokens was consumed entirely by hidden reasoning and the caller
 * was billed for empty output. This mirrors the chat/completions reasoning floor
 * so the two money paths agree. Pure, no I/O.
 */

import { describe, expect, test } from "bun:test";

import { messagesEffectiveMaxTokens } from "../v1/messages/route";

const MIN = 4096; // mirror of MESSAGES_MIN_RESPONSE_TOKENS — fail loudly if it moves

describe("messagesEffectiveMaxTokens", () => {
  test("non-reasoning model: requested budget passes through unchanged", () => {
    expect(messagesEffectiveMaxTokens(256, null, "openai/gpt-4o-mini")).toBe(
      256,
    );
    expect(
      messagesEffectiveMaxTokens(undefined, null, "openai/gpt-4o-mini"),
    ).toBeUndefined();
  });

  test("cerebras reasoning model: a small or absent budget is floored to MIN (no bill-for-empty)", () => {
    // Without the floor, 256 tokens are spent on hidden reasoning → empty but
    // billed output. gpt-oss-120b / gemma-4-31b match REASONING_MODEL_PATTERNS.
    expect(messagesEffectiveMaxTokens(256, null, "gpt-oss-120b")).toBe(MIN);
    expect(messagesEffectiveMaxTokens(undefined, null, "gemma-4-31b")).toBe(
      MIN,
    );
  });

  test("cerebras reasoning model: a larger requested budget is honored", () => {
    expect(messagesEffectiveMaxTokens(8000, null, "gpt-oss-120b")).toBe(8000);
  });

  test("Anthropic CoT: budget covers the thinking budget PLUS a response floor", () => {
    expect(messagesEffectiveMaxTokens(1000, 10000, "anthropic/claude-x")).toBe(
      10000 + MIN,
    );
  });
});
