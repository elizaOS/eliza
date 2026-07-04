// Fail-closed contract for the payout-network on-chain balance classifier.
//
// Regression target (#13415): checkEvmNetwork/checkSolanaNetwork computed
//   balance = Number(rawAmount) / 10 ** decimals
// with NO finite guard, then classified with `balance === 0` / `balance <
// LOW_BALANCE_THRESHOLD`. A corrupt/unreadable on-chain read that did NOT throw
// yielded balance = NaN, both comparisons were false, and the network fell
// through to status:"operational", hasBalance:true ("Operational with NaN
// tokens available"). That advertised an unverifiable payout wallet as available
// and enabled token redemption against it — a fail-OPEN money-availability gate.
// classifyPayoutNetworkBalance must degrade any non-finite balance to
// not_configured instead.
import { describe, expect, test } from "bun:test";
import { ELIZA_DECIMALS } from "../config/token-constants";
import { classifyPayoutNetworkBalance } from "./payout-status";

// 9 decimals for the elizaOS token across every supported network.
const DECIMALS = ELIZA_DECIMALS.solana; // === 9
const UNIT = 10 ** DECIMALS; // raw units per whole token
// LOW_BALANCE_THRESHOLD is a private module const (100 tokens); mirror it here.
const LOW_BALANCE_THRESHOLD = 100;

describe("classifyPayoutNetworkBalance — fail-closed on unreadable balances", () => {
  test("NaN raw balance does NOT fabricate operational (the fail-open regression)", () => {
    // Number("not-a-number") -> NaN, previously fell through to operational.
    const result = classifyPayoutNetworkBalance("not-a-number", DECIMALS);
    expect(result.status).toBe("not_configured");
    expect(result.hasBalance).toBe(false);
    expect(result.balance).toBe(0);
    // Explicitly assert the OLD fabricated verdict is gone.
    expect(result.status).not.toBe("operational");
    expect(result.status).not.toBe("low_balance");
    expect(result.message).not.toContain("NaN");
  });

  test("Infinity raw balance fails closed to not_configured", () => {
    const result = classifyPayoutNetworkBalance(Number.POSITIVE_INFINITY, DECIMALS);
    expect(result.status).toBe("not_configured");
    expect(result.hasBalance).toBe(false);
    expect(result.balance).toBe(0);
  });

  test("empty-string raw balance would compute NaN and fails closed", () => {
    // Number("") === 0 would be a false negative; only a genuinely-unparseable
    // value produces NaN. A whitespace/garbage token account amount does.
    const result = classifyPayoutNetworkBalance("  x ", DECIMALS);
    expect(result.status).toBe("not_configured");
    expect(result.hasBalance).toBe(false);
  });

  test("negative raw balance fails closed instead of advertising low-balance availability", () => {
    // Token account balances are unsigned. A negative value is a corrupt read;
    // low_balance has hasBalance:true and is considered available by
    // isNetworkAvailable(), so it must not be used for impossible negatives.
    const result = classifyPayoutNetworkBalance("-1", DECIMALS);
    expect(result.status).toBe("not_configured");
    expect(result.hasBalance).toBe(false);
    expect(result.balance).toBe(0);
  });
});

describe("classifyPayoutNetworkBalance — healthy classifications preserved", () => {
  test("zero raw balance -> no_balance (not fabricated operational)", () => {
    const result = classifyPayoutNetworkBalance(0n, DECIMALS);
    expect(result.status).toBe("no_balance");
    expect(result.hasBalance).toBe(false);
    expect(result.balance).toBe(0);
    expect(result.message).toBe("Payout wallet has no elizaOS tokens");
  });

  test("balance below the low-balance threshold -> low_balance", () => {
    // 50 whole tokens (< 100 threshold).
    const raw = BigInt(50 * UNIT);
    const result = classifyPayoutNetworkBalance(raw, DECIMALS);
    expect(result.status).toBe("low_balance");
    expect(result.hasBalance).toBe(true);
    expect(result.balance).toBe(50);
    expect(result.message).toContain(`threshold: ${LOW_BALANCE_THRESHOLD}`);
  });

  test("balance exactly at the threshold is operational (>= threshold)", () => {
    const raw = BigInt(LOW_BALANCE_THRESHOLD * UNIT);
    const result = classifyPayoutNetworkBalance(raw, DECIMALS);
    expect(result.status).toBe("operational");
    expect(result.hasBalance).toBe(true);
    expect(result.balance).toBe(LOW_BALANCE_THRESHOLD);
  });

  test("healthy balance above threshold -> operational with token count", () => {
    // 12,345 whole tokens.
    const raw = BigInt(12_345 * UNIT);
    const result = classifyPayoutNetworkBalance(raw, DECIMALS);
    expect(result.status).toBe("operational");
    expect(result.hasBalance).toBe(true);
    expect(result.balance).toBe(12_345);
    expect(result.message).toContain("12345.00 tokens available");
  });

  test("a bigint on-chain amount classifies without throwing (EVM/Solana read shape)", () => {
    // Both viem readContract and spl-token account.amount return bigint.
    const raw: bigint = BigInt(250 * UNIT);
    const result = classifyPayoutNetworkBalance(raw, DECIMALS);
    expect(result.status).toBe("operational");
    expect(result.balance).toBe(250);
  });
});
