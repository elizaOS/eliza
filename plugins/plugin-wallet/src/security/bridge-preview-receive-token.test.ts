/**
 * A bridge whose toToken differs from the sent token also swaps into that
 * token. The confirmation key binds toToken, so the prompt the user says yes
 * to must name it. Real walletFinancialPreview and walletFinancialPendingKey.
 */
import { describe, expect, it } from "vitest";
import {
  encodeWalletGovData,
  validateWalletGovParams,
} from "../chains/evm/gov-router";
import { parseWalletRouterParams } from "../types/wallet-router";
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

describe("pending key separator injection", () => {
  const G1 = `0x${"11".repeat(20)}`;
  const G2 = `0x${"22".repeat(20)}`;
  const T = `0x${"33".repeat(20)}`;
  const calls = {
    targets: [T],
    values: ["0"],
    calldatas: ["0x"],
    description: "d",
  };

  it("two different valid gov requests do not share a pending key", () => {
    // A: propose on G1; proposalId is unchecked free text for propose.
    const a = parseWalletRouterParams({
      subaction: "gov",
      chain: "base",
      op: "propose",
      governor: G1,
      proposalId: `x|slippageBps=|op=vote|governor=${G2}|proposalId=5`,
      support: 1,
      ...calls,
    });
    // B: castVote(5, for) on G2; toToken is ignored by the gov encoding.
    const b = parseWalletRouterParams({
      subaction: "gov",
      chain: "base",
      toToken: `|slippageBps=|op=propose|governor=${G1}|proposalId=x`,
      op: "vote",
      governor: G2,
      proposalId: "5",
      support: 1,
      ...calls,
    });
    expect(validateWalletGovParams(a)).toBeNull();
    expect(validateWalletGovParams(b)).toBeNull();
    expect(encodeWalletGovData(a)).not.toBe(encodeWalletGovData(b));
    expect(walletFinancialPendingKey(a)).not.toBe(walletFinancialPendingKey(b));
  });

  it("a backslash in a value cannot mimic an escaped separator", () => {
    const mk = (proposalId: string, support?: number) =>
      parseWalletRouterParams({
        subaction: "gov",
        chain: "base",
        op: "propose",
        governor: G1,
        proposalId,
        support,
        ...calls,
      });
    expect(walletFinancialPendingKey(mk("p\\", 1))).not.toBe(
      walletFinancialPendingKey(mk("p|support=1")),
    );
  });
});
