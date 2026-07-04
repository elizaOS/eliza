// Exercises cloud API tests chat reservation.test behavior with deterministic Worker route fixtures.
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ESTIMATED_OUTPUT_TOKENS,
  MAX_RESERVATION_OUTPUT_TOKENS,
  reservationOutputTokens,
} from "../v1/apps/[id]/chat/chat-reservation";

describe("reservationOutputTokens (#10924)", () => {
  test("falls back to the default estimate when max_tokens is absent/invalid", () => {
    expect(reservationOutputTokens(undefined)).toBe(
      DEFAULT_ESTIMATED_OUTPUT_TOKENS,
    );
    expect(reservationOutputTokens(null)).toBe(DEFAULT_ESTIMATED_OUTPUT_TOKENS);
    expect(reservationOutputTokens(0)).toBe(DEFAULT_ESTIMATED_OUTPUT_TOKENS);
    expect(reservationOutputTokens(-100)).toBe(DEFAULT_ESTIMATED_OUTPUT_TOKENS);
    expect(reservationOutputTokens(Number.NaN)).toBe(
      DEFAULT_ESTIMATED_OUTPUT_TOKENS,
    );
  });

  test("never reserves BELOW the default even for a tiny max_tokens", () => {
    // A caller passing max_tokens:100 could still, combined with the model, cost
    // at least the default estimate; reserving less re-opens the underestimate.
    expect(reservationOutputTokens(100)).toBe(DEFAULT_ESTIMATED_OUTPUT_TOKENS);
  });

  test("reserves for the caller's max_tokens ceiling (the fix — no more fixed 500)", () => {
    // The vulnerability: max_tokens forwarded to the provider but reserved as 500.
    expect(reservationOutputTokens(8000)).toBe(8000);
    expect(reservationOutputTokens(32000)).toBe(32000);
  });

  test("bounds a pathological max_tokens to the overflow guard", () => {
    expect(reservationOutputTokens(10_000_000)).toBe(
      MAX_RESERVATION_OUTPUT_TOKENS,
    );
    expect(reservationOutputTokens(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_ESTIMATED_OUTPUT_TOKENS,
    ); // Infinity is not finite → default, not the cap
  });
});
