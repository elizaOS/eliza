/**
 * A partial LP close or reposition can remove only part of a position: an
 * Aerodrome close takes an LP-token amount and a reposition passes one
 * through. That amount binds the confirmation pending key, so the prompt the
 * owner says yes to must name it. Real walletFinancialPreview and
 * walletFinancialPendingKey.
 */
import { describe, expect, it } from "vitest";
import {
  walletFinancialPendingKey,
  walletFinancialPreview,
} from "./wallet-financial-confirmation";

const base = {
  chain: "base",
  chainId: 8453,
  dex: "aerodrome",
  pool: "0xpool",
  position: "1234",
  tokenA: "WETH",
  tokenB: "USDC",
} as const;

describe("LP close/reposition confirmation", () => {
  it("names the part of the position a close removes", () => {
    const params = {
      ...base,
      subaction: "close",
      amount: "500000000000000000",
    } as never;
    const prompt = walletFinancialPreview(params);
    expect(prompt).toContain("with 500000000000000000");
    // The bound amount is the amount the prompt shows.
    expect(walletFinancialPendingKey(params)).toContain(
      "amount=500000000000000000",
    );
  });

  it("names the part of the position a reposition moves", () => {
    const prompt = walletFinancialPreview({
      ...base,
      subaction: "reposition",
      amount: "250000000000000000",
    } as never);
    expect(prompt).toContain("with 250000000000000000");
  });

  it("keeps the whole-position close reading unchanged", () => {
    const prompt = walletFinancialPreview({
      ...base,
      subaction: "close",
    } as never);
    // No amount clause: the only "with" left is the default-slippage phrase.
    expect(prompt).not.toMatch(/with \d/);
    expect(prompt).toContain("Close liquidity position 1234 in pool 0xpool");
  });
});
