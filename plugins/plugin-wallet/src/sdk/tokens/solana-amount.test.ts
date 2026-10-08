/** A SOL amount string with an extra dot must not be sent as a smaller amount. */
import { describe, expect, it } from "vitest";
import { parseSolLamports } from "./solana.ts";

describe("parseSolLamports", () => {
  it("rejects a second decimal point", () => {
    expect(() => parseSolLamports("1.5.2")).toThrow(/invalid SOL amount/);
  });

  it("rejects a negative amount that would change magnitude", () => {
    expect(() => parseSolLamports("-1.5")).toThrow(/invalid SOL amount/);
  });

  it("keeps whole, fractional, and leading-dot amounts", () => {
    expect(parseSolLamports("1")).toBe(1_000_000_000n);
    expect(parseSolLamports("1.5")).toBe(1_500_000_000n);
    expect(parseSolLamports("1.")).toBe(1_000_000_000n);
    expect(parseSolLamports(".5")).toBe(500_000_000n);
  });
});
