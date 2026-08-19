/** Pins the Solana signed-transaction recovery decision at the provider boundary. */
import { describe, expect, test } from "bun:test";
import { classifySolanaSweepRecovery } from "../direct-wallet-payments";

describe("Solana sweep acknowledgement recovery", () => {
  test("reuses the same signed transaction while an absent signature can still land", () => {
    expect(
      classifySolanaSweepRecovery({
        signatureStatus: null,
        currentBlockHeight: 500,
        lastValidBlockHeight: 500,
      }),
    ).toBe("resend");
  });

  test("reprepares only after signature-history absence and definitive blockhash expiry", () => {
    expect(
      classifySolanaSweepRecovery({
        signatureStatus: null,
        currentBlockHeight: 501,
        lastValidBlockHeight: 500,
      }),
    ).toBe("reprepare");
  });

  test("never resubmits or reprepares a transaction already visible in signature history", () => {
    expect(
      classifySolanaSweepRecovery({
        signatureStatus: { err: null },
        currentBlockHeight: 900,
        lastValidBlockHeight: 500,
      }),
    ).toBe("landed");
  });

  test("fails closed on an on-chain failed transaction", () => {
    expect(() =>
      classifySolanaSweepRecovery({
        signatureStatus: { err: { InstructionError: [0, "Custom"] } },
        currentBlockHeight: 500,
        lastValidBlockHeight: 500,
      }),
    ).toThrow("failed on chain");
  });
});
