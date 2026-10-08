/** A SOL amount string with an extra dot must not be sent as a smaller amount. */
import { describe, expect, it } from "vitest";
import { parseSolLamports, SolanaWallet } from "./solana.ts";

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
  it("preserves exact lamports and rejects fractional or out-of-range amounts before signer access", async () => {
    expect(parseSolLamports("0.0000000010")).toBe(1n);
    expect(parseSolLamports("18446744073.709551615")).toBe(
      18446744073709551615n,
    );
    const wallet = new SolanaWallet({ privateKeyBase58: "invalid-key" });
    for (const amount of [
      "0.0000000001",
      "1.1234567891",
      "18446744073.709551616",
      -1n,
      18446744073709551616n,
    ]) {
      await expect(
        wallet.sendSol("invalid-recipient", amount),
      ).rejects.toMatchObject({ code: "SOLANA_TRANSFER_AMOUNT_INVALID" });
    }
  });
});
