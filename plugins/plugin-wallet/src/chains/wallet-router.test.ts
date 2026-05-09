import type { HandlerOptions, IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { WalletBackendService } from "../services/wallet-backend-service";
import type {
  WalletChainHandler,
  WalletRouterExecution,
  WalletRouterParams,
} from "../types/wallet-router";
import { walletRouterAction } from "./wallet-action";

function createRuntime(): IAgentRuntime {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  };
  const runtime = {
    agentId: "test-agent",
    character: { name: "Test Agent", settings: {} },
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn(() => null),
    logger,
  };

  return runtime as unknown as IAgentRuntime;
}

function createService(): {
  readonly runtime: IAgentRuntime;
  readonly service: WalletBackendService;
} {
  const runtime = createRuntime();
  const service = new WalletBackendService(runtime);
  vi.mocked(runtime.getService).mockImplementation((name: string) =>
    name === WalletBackendService.serviceType ? service : null,
  );
  return { runtime, service };
}

function handler(
  chain: string,
  name: string,
  chainId: string,
  kind: "evm" | "solana",
  supportedActions: WalletChainHandler["supportedActions"] = [
    "transfer",
    "swap",
  ],
): WalletChainHandler {
  const execute = vi.fn(
    async (params: WalletRouterParams): Promise<WalletRouterExecution> => ({
      status: "submitted",
      chain,
      chainId,
      subaction: params.subaction,
      dryRun: false,
      mode: params.mode,
      transactionHash: kind === "evm" ? "0xtest" : undefined,
      signature: kind === "solana" ? "soltest" : undefined,
      amount: params.amount,
      fromToken: params.fromToken,
      toToken: params.toToken,
      to: params.recipient,
    }),
  );
  return {
    chain,
    name,
    chainId,
    aliases:
      kind === "solana"
        ? [chain, name, chainId, "sol"]
        : [chain, name, chainId],
    supportedActions,
    tokens: [
      {
        symbol: kind === "evm" ? "ETH" : "SOL",
        address:
          kind === "evm"
            ? "0x0000000000000000000000000000000000000000"
            : "So11111111111111111111111111111111111111112",
        decimals: kind === "evm" ? 18 : 9,
        native: true,
      },
    ],
    signer: {
      required: true,
      kind,
      source: "test",
    },
    dryRun: {
      supported: true,
      supportedActions,
    },
    execute,
  };
}

function message(): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text: "wallet action" },
    createdAt: Date.now(),
  } as Memory;
}

async function run(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
) {
  return walletRouterAction.handler(runtime, message(), undefined, {
    parameters,
  } as HandlerOptions);
}

describe("wallet router action", () => {
  it("routes EVM transfer through the selected chain handler", async () => {
    const { runtime, service } = createService();
    const base = handler("base", "Base", "8453", "evm");
    service.registerChainHandler(base);

    const result = await run(runtime, {
      subaction: "transfer",
      chain: "base",
      fromToken: "ETH",
      amount: "0.5",
      recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      mode: "execute",
    });

    expect(result?.success).toBe(true);
    expect(base.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        subaction: "transfer",
        chain: "base",
        amount: "0.5",
      }),
      expect.any(Object),
    );
    expect(result?.data?.chain).toBe("base");
    expect(result?.data?.transactionHash).toBe("0xtest");
  });

  it("routes EVM swap through the selected chain handler", async () => {
    const { runtime, service } = createService();
    const base = handler("base", "Base", "8453", "evm");
    service.registerChainHandler(base);

    const result = await run(runtime, {
      subaction: "swap",
      chain: "8453",
      fromToken: "0x0000000000000000000000000000000000000000",
      toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      amount: "1",
      slippageBps: 100,
      mode: "execute",
    });

    expect(result?.success).toBe(true);
    expect(base.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        subaction: "swap",
        chain: "8453",
        fromToken: "0x0000000000000000000000000000000000000000",
        toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      }),
      expect.any(Object),
    );
  });

  it("routes Solana transfer and swap through the Solana handler", async () => {
    const { runtime, service } = createService();
    const solana = handler("solana", "Solana", "solana-mainnet", "solana");
    service.registerChainHandler(solana);

    const transfer = await run(runtime, {
      subaction: "transfer",
      chain: "sol",
      fromToken: "SOL",
      amount: "2",
      recipient: "9xQeWvG816bUx9EPfWJXn4xHLh1BaK7Z7QXDXuGpS9SW",
      mode: "execute",
    });
    const swap = await run(runtime, {
      subaction: "swap",
      chain: "solana",
      fromToken: "SOL",
      toToken: "USDC",
      amount: "3",
      mode: "execute",
    });

    expect(transfer?.success).toBe(true);
    expect(swap?.success).toBe(true);
    expect(solana.execute).toHaveBeenCalledTimes(2);
    expect(solana.execute).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ subaction: "transfer" }),
      expect.any(Object),
    );
    expect(solana.execute).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ subaction: "swap" }),
      expect.any(Object),
    );
  });

  it("returns unsupported chain details without executing", async () => {
    const { runtime, service } = createService();
    const base = handler("base", "Base", "8453", "evm");
    service.registerChainHandler(base);

    const result = await run(runtime, {
      subaction: "transfer",
      chain: "doge",
      amount: "1",
      recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      mode: "execute",
    });

    expect(result?.success).toBe(false);
    expect(result?.data?.error).toBe("UNSUPPORTED_CHAIN");
    expect(base.execute).not.toHaveBeenCalled();
  });

  it("clarifies ambiguous omitted chains", async () => {
    const { runtime, service } = createService();
    const base = handler("base", "Base", "8453", "evm");
    const solana = handler("solana", "Solana", "solana-mainnet", "solana");
    service.registerChainHandler(base);
    service.registerChainHandler(solana);

    const result = await run(runtime, {
      subaction: "transfer",
      amount: "1",
      recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      mode: "execute",
    });

    expect(result?.success).toBe(false);
    expect(result?.data?.error).toBe("AMBIGUOUS_CHAIN");
    expect(String(result?.text)).toContain("Available chains");
    expect(base.execute).not.toHaveBeenCalled();
    expect(solana.execute).not.toHaveBeenCalled();
  });

  it("defaults omitted chain when only one handler supports subaction", async () => {
    const { runtime, service } = createService();
    const base = handler("base", "Base", "8453", "evm");
    service.registerChainHandler(base);

    const result = await run(runtime, {
      subaction: "swap",
      fromToken: "ETH",
      toToken: "USDC",
      amount: "1",
      mode: "execute",
    });

    expect(result?.success).toBe(true);
    expect(base.execute).toHaveBeenCalledWith(
      expect.objectContaining({ subaction: "swap" }),
      expect.any(Object),
    );
    expect(result?.data?.chain).toBe("base");
  });

  it("prepares dry-run metadata without executing", async () => {
    const { runtime, service } = createService();
    const base = handler("base", "Base", "8453", "evm");
    service.registerChainHandler(base);

    const result = await run(runtime, {
      subaction: "transfer",
      chain: "base",
      amount: "1",
      recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      dryRun: true,
      mode: "execute",
    });

    expect(result?.success).toBe(true);
    expect(result?.data?.dryRun).toBe(true);
    expect(result?.data?.metadata).toMatchObject({
      signer: { kind: "evm", required: true },
      dryRun: { supported: true },
    });
    expect(base.execute).not.toHaveBeenCalled();
  });
});
