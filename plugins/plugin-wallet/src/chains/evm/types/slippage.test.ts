/**
 * EVM swap/bridge `slippageBps` is swap-tolerance identity, leftover tax
 * after wallet-router `slippageBps`. Stock develop used z.coerce.number(),
 * which treated string `1e2` / `007` / `0x10` as a slippage instead of a
 * parse failure. fromToken / toToken / amount stay untouched. Missing
 * still means the chain default.
 */
import { describe, expect, it } from "vitest";
import { parseBridgeParams, parseSwapParams } from "./index.ts";

const NATIVE = "0x0000000000000000000000000000000000000000";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

const swapInput = {
  chain: "base",
  fromToken: NATIVE,
  toToken: USDC,
  amount: "1",
};

const bridgeInput = {
  fromChain: "base",
  toChain: "arbitrum",
  fromToken: NATIVE,
  toToken: NATIVE,
  amount: "0.5",
};

function parseSwap(slippageBps?: unknown) {
  const input: Record<string, unknown> = { ...swapInput };
  if (arguments.length > 0) {
    input.slippageBps = slippageBps;
  }
  return parseSwapParams(input);
}

function parseBridge(slippageBps?: unknown) {
  const input: Record<string, unknown> = { ...bridgeInput };
  if (arguments.length > 0) {
    input.slippageBps = slippageBps;
  }
  return parseBridgeParams(input);
}

describe("EVM swap/bridge slippageBps identity", () => {
  it("accepts omitted slippageBps as the chain-default tolerance", () => {
    expect(parseSwap().slippageBps).toBeUndefined();
    expect(parseBridge().slippageBps).toBeUndefined();
  });

  it("accepts slippageBps=50 as an exact swap tolerance", () => {
    expect(parseSwap(50).slippageBps).toBe(50);
    expect(parseBridge(50).slippageBps).toBe(50);
  });

  it("accepts slippageBps=0 as a legal zero-slippage quote", () => {
    expect(parseSwap(0).slippageBps).toBe(0);
    expect(parseSwap("0").slippageBps).toBe(0);
    expect(parseBridge(0).slippageBps).toBe(0);
    expect(parseBridge("0").slippageBps).toBe(0);
  });

  it("accepts canonical string slippageBps=250", () => {
    expect(parseSwap("250").slippageBps).toBe(250);
    expect(parseBridge("250").slippageBps).toBe(250);
  });

  it("rejects a canonical oversize slippageBps before routing", () => {
    expect(() => parseSwap(10001)).toThrow();
    expect(() => parseSwap("10001")).toThrow();
    expect(() => parseBridge(10001)).toThrow();
    expect(() => parseBridge("10001")).toThrow();
  });

  it.each(["1e2", "12px", "007", "abc", "-1", "50abc", " 50", "50 ", "0x10"])(
    "rejects prefix-coerced slippageBps=%s before routing",
    (token) => {
      expect(() => parseSwap(token)).toThrow();
      expect(() => parseBridge(token)).toThrow();
    },
  );
});
