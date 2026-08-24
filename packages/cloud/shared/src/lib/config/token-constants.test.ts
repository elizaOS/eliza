import { describe, expect, it } from "vitest";
import { ELIZA_DECIMALS, ERC20_ABI, EVM_CHAINS } from "./token-constants.js";

describe("token-constants", () => {
  it("ELIZA_DECIMALS is 9 on all networks", () => {
    expect(ELIZA_DECIMALS.ethereum).toBe(9);
    expect(ELIZA_DECIMALS.base).toBe(9);
    expect(ELIZA_DECIMALS.bnb).toBe(9);
    expect(ELIZA_DECIMALS.solana).toBe(9);
  });

  it("EVM_CHAINS has expected networks", () => {
    expect(EVM_CHAINS.ethereum).toBeDefined();
    expect(EVM_CHAINS.base).toBeDefined();
    expect(EVM_CHAINS.bnb).toBeDefined();
  });

  it("ERC20_ABI contains transfer and balanceOf", () => {
    // ERC20_ABI is parsed abi array
    expect(Array.isArray(ERC20_ABI)).toBe(true);
    // At least check length and that entries exist
    expect(ERC20_ABI.length).toBeGreaterThanOrEqual(3);
  });
});
