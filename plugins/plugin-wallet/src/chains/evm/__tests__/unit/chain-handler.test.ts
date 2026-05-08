import type { IAgentRuntime } from "@elizaos/core";
import { parseEther } from "viem";
import { base, mainnet } from "viem/chains";
import { describe, expect, it, vi } from "vitest";
import type { WalletRouterContext } from "../../../../types/wallet-router.js";
import { createEvmWalletChainHandler } from "../../chain-handler";
import evmPlugin from "../../index";
import type { WalletProvider } from "../../providers/wallet";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function createFakeWalletProvider(sendTransaction = vi.fn(async () => HASH)) {
  return {
    chains: { base },
    getSupportedChains: () => ["base"],
    getChainConfigs: () => base,
    getWalletClient: () => ({
      account: { address: ACCOUNT },
      sendTransaction,
    }),
  } as unknown as WalletProvider;
}

const context = {
  runtime: {} as IAgentRuntime,
  walletBackend: null,
  walletServices: [],
  tokenDataService: null,
} satisfies WalletRouterContext;

describe("EVM wallet chain handler", () => {
  it("prepares transfers without signing or sending", () => {
    const sendTransaction = vi.fn(async () => HASH);
    const handler = createEvmWalletChainHandler("base", base, {
      walletProvider: createFakeWalletProvider(sendTransaction),
    });

    const result = handler.prepareTransfer({
      subaction: "transfer",
      chain: "base",
      amount: "0.25",
      recipient: RECIPIENT,
      mode: "prepare",
      dryRun: true,
    });

    expect(result.status).toBe("prepared");
    expect(result.chain).toBe("base");
    expect(result.chainId).toBe(String(base.id));
    expect(result.to).toBe(RECIPIENT);
    expect(result.metadata?.transactionRequest).toMatchObject({
      to: RECIPIENT,
      value: parseEther("0.25").toString(),
      data: "0x",
      chainId: base.id,
    });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it("executes native transfers through the chain handler", async () => {
    const sendTransaction = vi.fn(async () => HASH);
    const handler = createEvmWalletChainHandler("base", base, {
      walletProvider: createFakeWalletProvider(sendTransaction),
    });

    const result = await handler.execute(
      {
        subaction: "transfer",
        chain: "base",
        amount: "0.25",
        recipient: RECIPIENT,
        mode: "execute",
        dryRun: false,
      },
      context
    );

    expect(result.status).toBe("submitted");
    expect(result.transactionHash).toBe(HASH);
    expect(result.chain).toBe("base");
    expect(result.chainId).toBe(String(base.id));
    expect(sendTransaction).toHaveBeenCalledTimes(1);
    expect(sendTransaction.mock.calls[0]?.[0]).toMatchObject({
      to: RECIPIENT,
      value: parseEther("0.25"),
      chain: base,
    });
  });

  it("preserves chain aliases and swap prepare metadata for the wallet router", () => {
    const handler = createEvmWalletChainHandler("mainnet", mainnet);
    const result = handler.prepareSwap({
      subaction: "swap",
      chain: "ethereum",
      fromToken: "ETH",
      toToken: USDC,
      amount: "1",
      slippageBps: 100,
      mode: "prepare",
      dryRun: true,
    });

    expect(handler.aliases).toEqual(
      expect.arrayContaining(["mainnet", "Ethereum", "1", "ETH", "ethereum", "eth"])
    );
    expect(result.status).toBe("prepared");
    expect(result.chain).toBe("mainnet");
    expect(result.chainId).toBe(String(mainnet.id));
    expect(result.metadata?.slippageBps).toBe(100);
  });

  it("does not register duplicate transfer or swap planner actions", () => {
    const actionNames = evmPlugin.actions?.map((action) => action.name) ?? [];

    expect(actionNames).toContain("WALLET");
    expect(actionNames).not.toContain("WALLET_ACTION");
    expect(actionNames).not.toContain("TRANSFER");
    expect(actionNames).not.toContain("SWAP");
  });
});
