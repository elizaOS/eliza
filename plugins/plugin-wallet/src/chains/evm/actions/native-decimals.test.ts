/**
 * Native-currency decimals are chain-specific: Tempo's native USD has 6, not
 * 18. These tests pin the three paths that turn a human amount into native
 * base units (or back) to the configured chain's `nativeCurrency.decimals`, so
 * a "1" transfer on a 6-decimal chain signs 1_000_000 base units rather than
 * 10^18, and keep the 18-decimal behaviour unchanged.
 */
import type { IAgentRuntime, Memory, State } from "@elizaos/core";
import type { Chain, PublicClient, WalletClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet, tempo } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import { type ChainBalanceState, WalletProvider } from "../providers/wallet";
import type { SupportedChain } from "../types";
import { buildSwapDetails } from "./swap";
import { TransferAction } from "./transfer";

const PRIVATE_KEY = generatePrivateKey();
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const RECIPIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const OUTPUT_TOKEN = "0x20c0000000000000000000000000000000000001";

const CHAINS: Record<string, Chain> = { tempo, mainnet };

function stubRuntime(modelReply = ""): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    character: { name: "Eliza", bio: [] },
    getSetting: () => undefined,
    getCache: async () => undefined,
    setCache: async () => true,
    composeState: async () => ({ values: {}, data: {}, text: "" }) as State,
    useModel: async () => modelReply,
  } as unknown as IAgentRuntime;
}

describe("TransferAction.transfer native value", () => {
  function transferOn(chain: SupportedChain, amount: string) {
    const sendTransaction = vi.fn(async (_params: { value?: bigint }) => "0xabc" as const);
    const walletProvider = {
      getWalletClient: () => ({ account: ACCOUNT, sendTransaction }) as unknown as WalletClient,
      getChainConfigs: (name: SupportedChain) => CHAINS[name],
    } as unknown as WalletProvider;
    return {
      sendTransaction,
      result: new TransferAction(walletProvider).transfer({
        fromChain: chain,
        toAddress: RECIPIENT,
        amount,
      }),
    };
  }

  it("signs 6-decimal base units on Tempo", async () => {
    const { sendTransaction, result } = transferOn("tempo" as SupportedChain, "1");
    const tx = await result;
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(sendTransaction.mock.calls[0]?.[0].value).toBe(1_000_000n);
    expect(tx.value).toBe(1_000_000n);
  });

  it("rejects an amount finer than the chain's native decimals", async () => {
    const { sendTransaction, result } = transferOn("tempo" as SupportedChain, "0.0000001");
    await expect(result).rejects.toThrow();
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("keeps 18-decimal base units on an 18-decimal chain", async () => {
    const { sendTransaction, result } = transferOn("mainnet", "1");
    await result;
    expect(sendTransaction.mock.calls[0]?.[0].value).toBe(10n ** 18n);
  });
});

describe("WalletProvider.getWalletBalanceForChain native formatting", () => {
  function providerWithBalance(raw: bigint) {
    const wp = new WalletProvider(PRIVATE_KEY, stubRuntime(), CHAINS);
    vi.spyOn(wp, "getPublicClient").mockReturnValue({
      getBalance: async () => raw,
    } as unknown as PublicClient);
    return wp;
  }

  it("formats a Tempo balance with 6 decimals", async () => {
    const wp = providerWithBalance(1_000_000n);
    await expect(wp.getWalletBalanceForChain("tempo" as SupportedChain)).resolves.toBe("1");
  });

  it("formats an 18-decimal balance unchanged", async () => {
    const wp = providerWithBalance(10n ** 18n);
    await expect(wp.getWalletBalanceForChain("mainnet")).resolves.toBe("1");
  });
});

describe("buildSwapDetails relative native amount", () => {
  function swapStub(chain: string, nativeBalance: string): WalletProvider {
    return {
      chains: CHAINS,
      getSupportedChains: () => [chain as SupportedChain],
      getChainBalanceStates: async () =>
        ({ [chain]: { status: "ok", balance: nativeBalance } }) as Record<
          SupportedChain,
          ChainBalanceState
        >,
      getChainConfigs: (name: SupportedChain) => CHAINS[name],
    } as unknown as WalletProvider;
  }

  async function relativeAmount(
    chain: string,
    nativeBalance: string,
    amountMode: "half" | "max" | "percent",
    amountPercent?: number
  ): Promise<string> {
    const reply = JSON.stringify({
      chain,
      amountMode,
      amountPercent,
      inputToken: CHAINS[chain]?.nativeCurrency.symbol,
      outputToken: OUTPUT_TOKEN,
    });
    const details = await buildSwapDetails(
      {} as State,
      { content: { text: "swap" } } as Memory,
      stubRuntime(reply),
      swapStub(chain, nativeBalance)
    );
    return details.amount;
  }

  it("resolves half and max of a Tempo balance in 6-decimal units", async () => {
    await expect(relativeAmount("tempo", "1", "half")).resolves.toBe("0.5");
    await expect(relativeAmount("tempo", "1", "max")).resolves.toBe("0.9");
    // 3 base units halve to 1 base unit; 18-decimal math would yield 0.0000015.
    await expect(relativeAmount("tempo", "0.000003", "half")).resolves.toBe("0.000001");
    await expect(relativeAmount("tempo", "1", "percent", 25)).resolves.toBe("0.25");
  });

  it("keeps 18-decimal relative amounts unchanged", async () => {
    await expect(relativeAmount("mainnet", "1", "half")).resolves.toBe("0.5");
    await expect(relativeAmount("mainnet", "1", "max")).resolves.toBe("0.9");
    await expect(relativeAmount("mainnet", "0.000003", "half")).resolves.toBe("0.0000015");
  });
});
