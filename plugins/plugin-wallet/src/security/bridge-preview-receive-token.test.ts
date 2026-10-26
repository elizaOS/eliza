/**
 * A bridge whose toToken differs from the sent token also swaps into that
 * token. The confirmation key binds toToken, so the prompt the user says yes
 * to must name it. Real walletFinancialPreview and walletFinancialPendingKey.
 */
import { describe, expect, it } from "vitest";
import {
  walletFinancialPendingKey,
  walletFinancialPreview,
} from "./wallet-financial-confirmation";

const base = {
  subaction: "bridge",
  chain: "base",
  toChain: "arbitrum",
  amount: "1000",
  fromToken: "USDC",
  slippageBps: 300,
} as const;

describe("bridge confirmation", () => {
  it("names a different receive token", () => {
    const prompt = walletFinancialPreview({
      ...base,
      toToken: "0x1111111111111111111111111111111111111111",
    } as never);
    expect(prompt).toContain("as 0x1111111111111111111111111111111111111111");
  });

  it("shows different prompts for confirmations bound to different receive tokens", () => {
    const tokens = [
      undefined,
      "USDC",
      "0x1111111111111111111111111111111111111111",
    ];
    const keys = new Set(
      tokens.map((toToken) =>
        walletFinancialPendingKey({ ...base, toToken } as never),
      ),
    );
    const prompts = new Set(
      tokens
        .filter(
          (toToken) => toToken?.toLowerCase() !== base.fromToken.toLowerCase(),
        )
        .map((toToken) =>
          walletFinancialPreview({ ...base, toToken } as never),
        ),
    );
    // The same-token bridge reads the same with or without toToken; every
    // other bound receive token gets its own prompt.
    expect(keys.size).toBe(3);
    expect(prompts.size).toBe(2);
  });
});

describe("pump.fun and liquidity confirmations", () => {
  it.each([
    {
      subaction: "pump_fun_buy",
      chain: "pumpfun",
      amount: "1",
      toToken: "Mint1111111111111111111111111111111111111111",
    },
    {
      subaction: "open",
      chain: "evm",
      chainId: 8453,
      pool: "0xpool",
      amount: "1",
    },
    {
      subaction: "close",
      chain: "evm",
      chainId: 8453,
      position: "123",
      dex: "uniswap",
    },
    {
      subaction: "reposition",
      chain: "evm",
      chainId: 8453,
      position: "123",
      dex: "uniswap",
    },
  ])("shows the bound slippage for $subaction", (params) => {
    const prompts = new Set(
      [undefined, 50, 10_000].map((slippageBps) =>
        walletFinancialPreview({ ...params, slippageBps } as never),
      ),
    );
    expect(prompts.size).toBe(3);
  });
});

describe("Solana address confirmation key", () => {
  it("does not let a base58 case variant match the confirmed recipient", () => {
    const transfer = {
      subaction: "transfer",
      chain: "solana",
      amount: "5",
      fromToken: "SOL",
    } as const;
    expect(
      walletFinancialPendingKey({
        ...transfer,
        recipient: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      } as never),
    ).not.toBe(
      walletFinancialPendingKey({
        ...transfer,
        recipient: "9wzdxwbbmkg8ztbnmquxvqrayrzzdsgydlvl9zytawwm",
      } as never),
    );
  });
});

describe("transfer confirmation", () => {
  it("names the native coin when no token is given", () => {
    const prompt = walletFinancialPreview({
      subaction: "transfer",
      chain: "base",
      amount: "2",
      recipient: "0x2222222222222222222222222222222222222222",
    } as never);
    expect(prompt).toContain("Transfer 2 of the native coin (not a token)");
    expect(prompt).not.toContain("tokens");
  });
});
