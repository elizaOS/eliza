import { describe, expect, it } from "bun:test";
import { COMMON_TOKENS, ERC20_ABI } from "../tokens";

describe("Token constants", () => {
  it("should have common tokens for Base (8453)", () => {
    const baseTokens = COMMON_TOKENS[8453];
    expect(baseTokens).toBeDefined();
    expect(baseTokens.length).toBeGreaterThanOrEqual(3);

    const usdc = baseTokens.find((t) => t.symbol === "USDC");
    expect(usdc).toBeDefined();
    expect(usdc?.address).toBe("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
    expect(usdc?.decimals).toBe(6);

    const usdbc = baseTokens.find((t) => t.symbol === "USDbC");
    expect(usdbc).toBeDefined();
    expect(usdbc?.decimals).toBe(6);

    const weth = baseTokens.find((t) => t.symbol === "WETH");
    expect(weth).toBeDefined();
    expect(weth?.decimals).toBe(18);
  });

  it("should have common tokens for Ethereum (1)", () => {
    const ethTokens = COMMON_TOKENS[1];
    expect(ethTokens).toBeDefined();
    expect(ethTokens.length).toBeGreaterThanOrEqual(4);

    const symbols = ethTokens.map((t) => t.symbol);
    expect(symbols).toContain("USDC");
    expect(symbols).toContain("USDT");
    expect(symbols).toContain("WETH");
    expect(symbols).toContain("DAI");
  });

  it("should have common tokens for BSC (56)", () => {
    const bscTokens = COMMON_TOKENS[56];
    expect(bscTokens).toBeDefined();
    expect(bscTokens.length).toBeGreaterThanOrEqual(3);

    const symbols = bscTokens.map((t) => t.symbol);
    expect(symbols).toContain("USDT");
    expect(symbols).toContain("BUSD");
    expect(symbols).toContain("WBNB");
  });

  it("should have common tokens for Polygon (137)", () => {
    const polyTokens = COMMON_TOKENS[137];
    expect(polyTokens).toBeDefined();
    expect(polyTokens.length).toBeGreaterThanOrEqual(3);
  });

  it("should have common tokens for Arbitrum (42161)", () => {
    const arbTokens = COMMON_TOKENS[42161];
    expect(arbTokens).toBeDefined();
    expect(arbTokens.length).toBeGreaterThanOrEqual(3);
  });

  it("all token addresses should be valid checksummed addresses", () => {
    for (const [_chainId, tokens] of Object.entries(COMMON_TOKENS)) {
      for (const token of tokens) {
        expect(token.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
        expect(token.symbol.length).toBeGreaterThan(0);
        expect(token.decimals).toBeGreaterThanOrEqual(0);
        expect(token.decimals).toBeLessThanOrEqual(18);
      }
    }
  });

  it("should return empty array for unsupported chain", () => {
    const tokens = COMMON_TOKENS[999999];
    expect(tokens).toBeUndefined();
  });
});

describe("ERC20_ABI", () => {
  it("should have balanceOf, decimals, and symbol functions", () => {
    const functionNames = ERC20_ABI.map((entry) => entry.name);
    expect(functionNames).toContain("balanceOf");
    expect(functionNames).toContain("decimals");
    expect(functionNames).toContain("symbol");
  });

  it("balanceOf should take an address and return uint256", () => {
    const balanceOf = ERC20_ABI.find((e) => e.name === "balanceOf")!;
    expect(balanceOf.inputs[0].type).toBe("address");
    expect(balanceOf.outputs[0].type).toBe("uint256");
    expect(balanceOf.stateMutability).toBe("view");
  });
});
