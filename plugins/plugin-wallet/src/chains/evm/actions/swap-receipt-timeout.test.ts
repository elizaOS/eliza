/**
 * An EVM swap is broadcast first, then its receipt is awaited. When the
 * receipt cannot be read in time, the swap may still land: it must be
 * reported as unconfirmed, not as failed, or a retry swaps the same funds
 * again. A reverted swap still fails. Real SwapAction route executor; the
 * wallet and public clients are recorded.
 */
import type { PublicClient, WalletClient } from "viem";
import { WaitForTransactionReceiptTimeoutError } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import { NATIVE_TOKEN_ADDRESS } from "../constants";
import type { WalletProvider } from "../providers/wallet";
import type { SupportedChain } from "../types";
import { SwapAction } from "./swap";

const ACCOUNT = privateKeyToAccount(generatePrivateKey());
const ROUTER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const HASH = `0x${"ab".repeat(32)}` as const;

function swapWith(waitForTransactionReceipt: () => Promise<unknown>) {
  const sendTransaction = vi.fn(async () => HASH);
  const walletProvider = {
    getWalletClient: () =>
      ({ account: ACCOUNT, chain: mainnet, sendTransaction }) as unknown as WalletClient,
    getPublicClient: () => ({ waitForTransactionReceipt }) as unknown as PublicClient,
    chains: { mainnet },
    getChainConfigs: () => mainnet,
  } as unknown as WalletProvider;
  const action = new SwapAction(walletProvider) as unknown as {
    executeBebopQuote: (
      quote: unknown,
      params: unknown
    ) => Promise<{ hash: string; confirmationStatus?: string }>;
  };
  return action.executeBebopQuote(
    {
      aggregator: "bebop",
      swapData: {
        data: "0x",
        approvalTarget: ROUTER,
        sellAmount: "1000000000000000000",
        from: ACCOUNT.address,
        to: ROUTER,
        value: "1000000000000000000",
        gas: "200000",
        gasPrice: "1",
      },
    },
    {
      chain: "mainnet" as SupportedChain,
      fromToken: NATIVE_TOKEN_ADDRESS,
      toToken: ROUTER,
      amount: "1",
    }
  );
}

describe("EVM swap receipt wait", () => {
  it("reports a broadcast swap whose receipt timed out as unconfirmed", async () => {
    const tx = await swapWith(async () => {
      throw new WaitForTransactionReceiptTimeoutError({ hash: HASH });
    });
    expect(tx.hash).toBe(HASH);
    expect(tx.confirmationStatus).toBe("unconfirmed");
  });

  it("reports a mined swap as confirmed", async () => {
    const tx = await swapWith(async () => ({ status: "success" }));
    expect(tx.confirmationStatus).toBe("confirmed");
  });

  it("still fails a reverted swap", async () => {
    await expect(swapWith(async () => ({ status: "reverted" }))).rejects.toThrow(
      "Bebop swap reverted"
    );
  });
});
