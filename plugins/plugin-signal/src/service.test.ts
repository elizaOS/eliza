/**
 * Unit test for SignalService's outbound message chunking: a raw-limit
 * fallback cut must never split a UTF-16 surrogate pair (emoji) across
 * chunks. splitMessage is pure (no runtime/client state), so it's exercised
 * directly on a no-arg instance rather than standing up a full service.
 */
import { describe, expect, it } from "vitest";
import { SignalService } from "./service";
import { MAX_SIGNAL_MESSAGE_LENGTH } from "./types";

function splitMessage(text: string): string[] {
  const service = new SignalService();
  return (service as unknown as { splitMessage(text: string): string[] }).splitMessage(text);
}

describe("SignalService.splitMessage", () => {
  it("keeps a surrogate pair (emoji) intact instead of splitting it across chunks", () => {
    // A leading single-width char shifts the emoji run onto an odd offset,
    // so the raw-limit fallback cut (no newline/space nearby) lands between
    // a pair's high and low surrogate instead of coincidentally on a
    // pair boundary.
    const text = `a${"🙂".repeat(MAX_SIGNAL_MESSAGE_LENGTH)}`;

    const chunks = splitMessage(text);

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_SIGNAL_MESSAGE_LENGTH);
      expect(chunk.isWellFormed()).toBe(true);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("still prefers a newline boundary when one is available near the limit", () => {
    const firstLine = "x".repeat(MAX_SIGNAL_MESSAGE_LENGTH - 1);
    const secondLine = "y".repeat(10);
    const text = `${firstLine}\n${secondLine}`;

    const chunks = splitMessage(text);

    expect(chunks).toEqual([`${firstLine}\n`, secondLine]);
  });

  it("returns the original text unchanged when under the limit", () => {
    const text = "hello world";
    expect(splitMessage(text)).toEqual([text]);
  });
});
