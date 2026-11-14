/**
 * Exercises `walletRouterAction`'s real chain-selection, confirmation-gate,
 * and dry-run logic end to end against fake `IAgentRuntime`/chain-handler
 * doubles — no live model, network, or chain, but the routing/gating code
 * under test is the real production path, not a stub.
 */
import {
  type HandlerOptions,
  type IAgentRuntime,
  type Memory,
  validateToolArgs,
} from "@elizaos/core";
import { decodeFunctionData, parseAbi } from "viem";
import { describe, expect, it, vi } from "vitest";
import { WalletBackendService } from "../../services/wallet-backend-service";
import type {
  WalletChainHandler,
  WalletRouterExecution,
  WalletRouterParams,
} from "../../types/wallet-router";
import { registerDefaultWalletChainHandlers } from "../registry";
import { walletRouterAction } from "../wallet-action";

const USDC_EVM = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// The signer boundary is the only double: routing, validation, the
// confirmation gate and calldata encoding all run for real.
const govSigner = vi.hoisted(() => ({
  account: { address: "0x1111111111111111111111111111111111111111" },
  getWalletClient: vi.fn(),
  sendTransaction: vi.fn(),
}));

vi.mock("../evm/providers/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../evm/providers/wallet")>()),
  initWalletProvider: vi.fn(async () => ({
    getWalletClient: govSigner.getWalletClient,
  })),
}));

function createRuntime(): IAgentRuntime {
  const logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    warn: vi.fn(),
  };
  const cache = new Map<string, unknown>();
  const runtime = {
    agentId: "test-agent",
    character: { name: "Test Agent", settings: {} },
    getService: vi.fn(() => null),
    getServicesByType: vi.fn(() => []),
    getSetting: vi.fn(() => null),
    getCache: vi.fn(async <T>(key: string) => cache.get(key) as T | undefined),
    setCache: vi.fn(async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    }),
    deleteCache: vi.fn(async (key: string) => {
      cache.delete(key);
      return true;
    }),
    logger,
  };

  return runtime as IAgentRuntime;
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
  // Omitted (default []) reproduces a handler that never opted into
  // simulate: no `simulation` capability and no `simulate` function at all,
  // matching every non-Solana handler today.
  simulateActions: WalletChainHandler["supportedActions"] = [],
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
  const simulate =
    simulateActions.length > 0
      ? vi.fn(
          async (
            params: WalletRouterParams,
          ): Promise<WalletRouterExecution> => ({
            status: "simulated",
            chain,
            chainId,
            subaction: params.subaction,
            dryRun: params.dryRun,
            mode: params.mode,
            amount: params.amount,
            fromToken: params.fromToken,
            toToken: params.toToken,
            simulation: {
              success: true,
              err: null,
              logs: ["Program log: ok"],
              unitsConsumed: 1_000,
              route: [],
              requestedSlippageBps: null,
              effectiveSlippageBps: null,
              summary: {},
            },
          }),
        )
      : undefined;
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
    ...(simulateActions.length > 0
      ? { simulation: { supported: true, supportedActions: simulateActions } }
      : {}),
    execute,
    simulate,
  };
}

function message(text = "wallet action"): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

async function runConfirmed(
  runtime: IAgentRuntime,
  parameters: Record<string, unknown>,
) {
  const first = await walletRouterAction.handler(
    runtime,
    message("please transfer"),
    undefined,
    { parameters } as HandlerOptions,
  );
  expect(first?.data?.requiresConfirmation).toBe(true);
  return walletRouterAction.handler(
    runtime,
    message("yes, confirm"),
    undefined,
    { parameters } as HandlerOptions,
  );
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
  it("routes gov through the default EVM handler and discloses the vote before signing", async () => {
    const { runtime, service } = createService();
    runtime.character.settings = { chains: { evm: ["base"] } };
    registerDefaultWalletChainHandlers(service, runtime);
    const governor = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
    const vote = {
      subaction: "gov",
      chain: "base",
      op: "vote",
      governor,
      proposalId: "12",
      support: 1,
    };

    const dryRun = await run(runtime, { ...vote, dryRun: true });
    expect(dryRun?.success).toBe(true);
    expect(dryRun?.data?.status).toBe("prepared");
    expect(dryRun?.data?.subaction).toBe("gov");

    const missingGovernor = await run(runtime, {
      ...vote,
      governor: undefined,
      mode: "execute",
    });
    expect(missingGovernor?.success).toBe(false);
    expect(missingGovernor?.data?.error).toBe("INVALID_PARAMS");
    expect(missingGovernor?.text).toBe("governor must be a valid EVM address.");

    const badProposalId = await run(runtime, {
      ...vote,
      proposalId: "twelve",
      mode: "execute",
    });
    expect(badProposalId?.success).toBe(false);
    expect(badProposalId?.data?.error).toBe("INVALID_PARAMS");
    expect(badProposalId?.data?.requiresConfirmation).toBeUndefined();
    expect(badProposalId?.text).toBe(
      "proposalId must be a base-10 integer string.",
    );

    const pending = await run(runtime, { ...vote, mode: "execute" });
    expect(pending?.data?.requiresConfirmation).toBe(true);
    expect(pending?.text).toBe(
      `Governance vote proposal 12 for at governor ${governor} on base? Reply yes to submit or no to cancel.`,
    );

    const target = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const propose = {
      subaction: "gov",
      chain: "base",
      op: "propose",
      governor,
      targets: [target],
      values: ["0"],
      calldatas: ["0xa9059cbb"],
      description: "Fund grants",
      mode: "execute",
    };
    for (const [change, detail] of [
      [
        { targets: ["treasury"] },
        "targets must contain only valid EVM addresses.",
      ],
      [{ values: ["0.1"] }, "values must be a base-10 integer string."],
      [
        { calldatas: ["0xa9059cb"] },
        "calldatas must contain only hex calldata values.",
      ],
      [
        { calldatas: ["0xa9059cbb", "0x"] },
        "targets, values and calldatas must have the same length for governance propose.",
      ],
    ] as const) {
      const refused = await run(runtime, { ...propose, ...change });
      expect(refused?.data?.error).toBe("INVALID_PARAMS");
      expect(refused?.text).toBe(detail);
    }

    const proposal = await run(runtime, propose);
    expect(proposal?.data?.requiresConfirmation).toBe(true);
    expect(proposal?.text).toBe(
      `Governance propose targets ${target} values (wei) 0 calldatas 0xa9059cbb "Fund grants" at governor ${governor} on base? Reply yes to submit or no to cancel.`,
    );
  });

  it("signs only the confirmed gov vote and rejects a changed vote or proposal payload", async () => {
    const { runtime, service } = createService();
    runtime.character.settings = { chains: { evm: ["base"] } };
    registerDefaultWalletChainHandlers(service, runtime);
    govSigner.sendTransaction.mockReset().mockResolvedValue("0xgovhash");
    govSigner.getWalletClient.mockReset().mockReturnValue({
      account: govSigner.account,
      sendTransaction: govSigner.sendTransaction,
    });
    const governor = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";
    const target = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const vote = {
      subaction: "gov",
      chain: "base",
      op: "vote",
      governor,
      proposalId: "12",
      support: 1,
      mode: "execute",
    };
    const confirm = (parameters: Record<string, unknown>) =>
      walletRouterAction.handler(runtime, message("yes, confirm"), undefined, {
        parameters,
      } as HandlerOptions);

    const pendingVote = await run(runtime, vote);
    expect(pendingVote?.data?.requiresConfirmation).toBe(true);

    // A "yes" carrying the opposite vote direction is a different action: it
    // must re-prompt with the new direction instead of signing.
    const flipped = await confirm({ ...vote, support: 0 });
    expect(flipped?.data?.requiresConfirmation).toBe(true);
    expect(flipped?.text).toContain("proposal 12 against");
    expect(govSigner.sendTransaction).not.toHaveBeenCalled();

    const submitted = await confirm(vote);
    expect(submitted?.success).toBe(true);
    expect(submitted?.data?.status).toBe("submitted");
    expect(submitted?.data?.transactionHash).toBe("0xgovhash");
    expect(govSigner.getWalletClient).toHaveBeenCalledWith("base");
    expect(govSigner.sendTransaction).toHaveBeenCalledTimes(1);
    const voteTx = govSigner.sendTransaction.mock.calls[0][0];
    expect(voteTx.to).toBe(governor);
    expect(voteTx.value).toBe(0n);
    expect(voteTx.chain.id).toBe(8453);
    expect(voteTx.account).toBe(govSigner.account);
    expect(
      decodeFunctionData({
        abi: parseAbi(["function castVote(uint256,uint8) returns (uint256)"]),
        data: voteTx.data,
      }),
    ).toEqual({ functionName: "castVote", args: [12n, 1] });

    // The confirmation is single-use: replaying the "yes" re-prompts.
    govSigner.sendTransaction.mockClear();
    const replayed = await confirm(vote);
    expect(replayed?.data?.requiresConfirmation).toBe(true);
    expect(govSigner.sendTransaction).not.toHaveBeenCalled();

    const proposal = {
      subaction: "gov",
      chain: "base",
      op: "propose",
      governor,
      targets: [target],
      values: ["0"],
      calldatas: ["0xa9059cbb"],
      description: "Fund grants",
      mode: "execute",
    };
    const pendingProposal = await run(runtime, proposal);
    expect(pendingProposal?.data?.requiresConfirmation).toBe(true);
    for (const changed of [
      { targets: [governor] },
      { values: ["1000000000000000000"] },
      { calldatas: ["0x095ea7b3"] },
      { description: "Fund grants v2" },
      { governor: target },
    ]) {
      const result = await confirm({ ...proposal, ...changed });
      expect(result?.data?.requiresConfirmation).toBe(true);
      expect(govSigner.sendTransaction).not.toHaveBeenCalled();
    }

    const proposed = await confirm(proposal);
    expect(proposed?.data?.status).toBe("submitted");
    expect(govSigner.sendTransaction).toHaveBeenCalledTimes(1);
    const proposeTx = govSigner.sendTransaction.mock.calls[0][0];
    expect(proposeTx.to).toBe(governor);
    expect(proposeTx.value).toBe(0n);
    expect(
      decodeFunctionData({
        abi: parseAbi([
          "function propose(address[],uint256[],bytes[],string) returns (uint256)",
        ]),
        data: proposeTx.data,
      }).args,
    ).toEqual([[target], [0n], ["0xa9059cbb"], "Fund grants"]);
  });

  it("routes EVM transfer through the selected chain handler", async () => {
    const { runtime, service } = createService();
    const base = handler("base", "Base", "8453", "evm");
    service.registerChainHandler(base);

    const result = await runConfirmed(runtime, {
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

  it("routes a planner transfer to the chain named in the declared target parameter", async () => {
    const { runtime, service } = createService();
    registerDefaultWalletChainHandlers(service, runtime);
    const recipient = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

    const validation = validateToolArgs(walletRouterAction, {
      action: "transfer",
      target: "base",
      fromToken: "ETH",
      amount: "0.2",
      recipient,
      mode: "execute",
    });
    expect(validation.errors).toEqual([]);

    const result = await walletRouterAction.handler(
      runtime,
      message(`Send 0.2 ETH on Base to ${recipient}`),
      undefined,
      { parameters: validation.args } as HandlerOptions,
    );

    expect(result?.data?.error).toBeUndefined();
    expect(result?.data?.requiresConfirmation).toBe(true);
    expect(result?.text).toBe(
      `Transfer 0.2 ETH to ${recipient} on base? Reply yes to submit or no to cancel.`,
    );
  });

  it("refuses a malformed transfer recipient before the spend confirmation", async () => {
    const { runtime, service } = createService();
    const base = handler("base", "Base", "8453", "evm");
    service.registerChainHandler(base);
    const solana = handler("solana", "Solana", "solana-mainnet", "solana");
    service.registerChainHandler(solana);

    const badEvm = await run(runtime, {
      subaction: "transfer",
      chain: "base",
      fromToken: "ETH",
      amount: "0.5",
      recipient: "0x123",
      mode: "execute",
    });
    expect(badEvm?.success).toBe(false);
    expect(badEvm?.data?.error).toBe("INVALID_PARAMS");
    expect(badEvm?.data?.requiresConfirmation).toBeUndefined();
    expect(badEvm?.text).toBe("recipient must be a valid EVM address.");
    expect(base.execute).not.toHaveBeenCalled();

    const badSolana = await run(runtime, {
      subaction: "transfer",
      chain: "solana",
      fromToken: "SOL",
      amount: "2",
      recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      mode: "execute",
    });
    expect(badSolana?.success).toBe(false);
    expect(badSolana?.data?.error).toBe("INVALID_PARAMS");
    expect(badSolana?.data?.requiresConfirmation).toBeUndefined();
    expect(badSolana?.text).toBe(
      "recipient must be a valid Solana base58 address.",
    );
    expect(solana.execute).not.toHaveBeenCalled();
  });

  it("refuses a transfer before the spend confirmation when the selected Steward backend did not load", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.getSetting).mockImplementation((key: string) =>
      key === "ELIZA_WALLET_BACKEND" ? "steward" : null,
    );
    const service = await WalletBackendService.start(runtime);
    vi.mocked(runtime.getService).mockImplementation((name: string) =>
      name === WalletBackendService.serviceType ? service : null,
    );
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

    expect(result?.success).toBe(false);
    expect(result?.data?.requiresConfirmation).toBeUndefined();
    expect(result?.data?.error).toBe("EXECUTION_FAILED");
    expect(String(result?.text)).toContain(
      "Steward is the selected wallet backend but it did not load",
    );
    expect(base.execute).not.toHaveBeenCalled();
  });

  it("refuses a transfer on a cloud-primary chain instead of signing with the local key", async () => {
    const { runtime, service } = createService();
    vi.mocked(runtime.getSetting).mockImplementation((key: string) =>
      key === "WALLET_SOURCE_EVM" ? "cloud" : null,
    );
    const base = handler("base", "Base", "8453", "evm");
    const solana = handler("solana", "Solana", "solana-mainnet", "solana");
    service.registerChainHandler(base);
    service.registerChainHandler(solana);

    const refused = await run(runtime, {
      subaction: "transfer",
      chain: "base",
      fromToken: "ETH",
      amount: "0.5",
      recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      mode: "execute",
    });

    expect(refused?.success).toBe(false);
    expect(refused?.data?.requiresConfirmation).toBeUndefined();
    expect(refused?.data?.error).toBe("EXECUTION_FAILED");
    expect(String(refused?.text)).toContain(
      "The primary EVM wallet is the Eliza Cloud wallet",
    );
    expect(base.execute).not.toHaveBeenCalled();

    // The Solana primary is still local, so its transfer runs.
    const sent = await runConfirmed(runtime, {
      subaction: "transfer",
      chain: "solana",
      fromToken: "SOL",
      amount: "0.5",
      recipient: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      mode: "execute",
    });

    expect(sent?.success).toBe(true);
    expect(solana.execute).toHaveBeenCalled();
  });

  it("routes EVM swap through the selected chain handler", async () => {
    const { runtime, service } = createService();
    const base = handler("base", "Base", "8453", "evm");
    service.registerChainHandler(base);

    const result = await runConfirmed(runtime, {
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

    const transfer = await runConfirmed(runtime, {
      subaction: "transfer",
      chain: "sol",
      fromToken: "SOL",
      amount: "2",
      recipient: "9xQeWvG816bUx9EPfWJXn4xHLh1BaK7Z7QXDXuGpS9SW",
      mode: "execute",
    });
    const swap = await runConfirmed(runtime, {
      subaction: "swap",
      chain: "solana",
      fromToken: "SOL",
      toToken: USDC_MINT,
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

  it("refuses a token symbol no handler can resolve before the spend confirmation", async () => {
    const { runtime, service } = createService();
    registerDefaultWalletChainHandlers(service, runtime);
    const recipient = "0x742d35Cc6634C0532925a3b844Bc454e4438f44e";

    for (const [parameters, text] of [
      [
        { action: "swap", target: "base", fromToken: "ETH", toToken: "USDC" },
        'toToken "USDC" must be the native token or a token contract address on Base. No token data service is registered to resolve a symbol.',
      ],
      [
        { action: "transfer", target: "base", fromToken: "USDC", recipient },
        'fromToken "USDC" must be the native token or a token contract address on Base. No token data service is registered to resolve a symbol.',
      ],
      [
        { action: "swap", target: "solana", fromToken: "SOL", toToken: "USDC" },
        'toToken "USDC" must be SOL or a Solana token mint address. Token symbols are not resolved on Solana.',
      ],
      [
        {
          action: "transfer",
          target: "solana",
          fromToken: "USDC",
          recipient: "9xQeWvG816bUx9EPfWJXn4xHLh1BaK7Z7QXDXuGpS9SW",
        },
        'fromToken "USDC" must be SOL or a Solana token mint address. Token symbols are not resolved on Solana.',
      ],
    ] as const) {
      const result = await run(runtime, {
        ...parameters,
        amount: "1",
        mode: "execute",
      });
      expect(result?.success).toBe(false);
      expect(result?.data?.error).toBe("INVALID_PARAMS");
      expect(result?.data?.requiresConfirmation).toBeUndefined();
      expect(result?.text).toBe(text);
    }

    for (const parameters of [
      { target: "base", fromToken: "ETH", toToken: USDC_EVM },
      { target: "solana", fromToken: "SOL", toToken: USDC_MINT },
    ]) {
      const result = await run(runtime, {
        ...parameters,
        action: "swap",
        amount: "1",
        mode: "execute",
      });
      expect(result?.data?.error).toBeUndefined();
      expect(result?.data?.requiresConfirmation).toBe(true);
    }
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

  it("routes chain eth to Ethereum mainnet with the default EVM chains", async () => {
    const { runtime, service } = createService();
    registerDefaultWalletChainHandlers(service, runtime);

    for (const [chain, routedChain, routedChainId] of [
      ["eth", "mainnet", "1"],
      ["ETH", "mainnet", "1"],
      ["base", "base", "8453"],
    ] as const) {
      const prepared = await run(runtime, {
        subaction: "transfer",
        chain,
        fromToken: "ETH",
        amount: "0.5",
        recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        dryRun: true,
        mode: "execute",
      });
      expect(prepared?.success).toBe(true);
      expect(prepared?.data?.status).toBe("prepared");
      expect(prepared?.data?.chain).toBe(routedChain);
      expect(prepared?.data?.chainId).toBe(routedChainId);
    }
  });

  it("resolves the bridge destination before the spend confirmation", async () => {
    const { runtime, service } = createService();
    registerDefaultWalletChainHandlers(service, runtime);
    const bridge = {
      action: "bridge",
      fromToken: "ETH",
      amount: "0.1",
      mode: "execute",
    };

    const unconfigured = await run(runtime, {
      ...bridge,
      target: "base",
      toChain: "arbitrum",
    });
    expect(unconfigured?.data?.error).toBe("UNSUPPORTED_CHAIN");
    expect(unconfigured?.data?.requiresConfirmation).toBeUndefined();
    expect(unconfigured?.text).toBe(
      'Unsupported destination chain "arbitrum" for bridge. Supported chains: mainnet, base, bsc.',
    );

    const sameChain = await run(runtime, {
      ...bridge,
      target: "8453",
      toChain: "base",
    });
    expect(sameChain?.data?.error).toBe("INVALID_PARAMS");
    expect(sameChain?.data?.requiresConfirmation).toBeUndefined();
    expect(sameChain?.text).toBe(
      "Source and destination chains must be different for bridge.",
    );

    const aliased = await run(runtime, {
      ...bridge,
      target: "base",
      toChain: "ethereum",
    });
    expect(aliased?.data?.error).toBeUndefined();
    expect(aliased?.data?.requiresConfirmation).toBe(true);
  });

  it("passes the resolved bridge destination chain key to the handler", async () => {
    const { runtime, service } = createService();
    const actions: WalletChainHandler["supportedActions"] = ["bridge"];
    const base = handler("base", "Base", "8453", "evm", actions);
    service.registerChainHandler(base);
    service.registerChainHandler({
      ...handler("mainnet", "Ethereum", "1", "evm", actions),
      aliases: ["mainnet", "ethereum"],
    });

    const result = await runConfirmed(runtime, {
      action: "bridge",
      target: "base",
      toChain: "Ethereum",
      fromToken: "ETH",
      amount: "0.1",
      mode: "execute",
    });

    expect(result?.success).toBe(true);
    expect(base.execute).toHaveBeenCalledWith(
      expect.objectContaining({ subaction: "bridge", toChain: "mainnet" }),
      expect.any(Object),
    );
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

    const result = await runConfirmed(runtime, {
      subaction: "swap",
      fromToken: "ETH",
      toToken: USDC_EVM,
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

  it("routes confirmed pump.fun buys through the pump.fun Solana handler", async () => {
    const { runtime, service } = createService();
    const pumpfun = handler(
      "pumpfun",
      "pump.fun",
      "pump.fun-solana",
      "solana",
      ["pump_fun_buy"],
    );
    service.registerChainHandler(pumpfun);

    const mint = "So11111111111111111111111111111111111111112";
    const result = await runConfirmed(runtime, {
      action: "pump.fun buy",
      token: mint,
      amount: "0.01",
      mode: "execute",
    });

    expect(result?.success).toBe(true);
    expect(pumpfun.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        subaction: "pump_fun_buy",
        toToken: mint,
        amount: "0.01",
      }),
      expect.any(Object),
    );
    expect(result?.data?.chain).toBe("pumpfun");
    expect(result?.data?.signature).toBe("soltest");
  });

  it("rejects pump.fun buys without a token mint before confirmation", async () => {
    const { runtime, service } = createService();
    const pumpfun = handler(
      "pumpfun",
      "pump.fun",
      "pump.fun-solana",
      "solana",
      ["pump_fun_buy"],
    );
    service.registerChainHandler(pumpfun);

    const result = await run(runtime, {
      action: "PUMPFUN_BUY",
      amount: "0.01",
      mode: "execute",
    });

    expect(result?.success).toBe(false);
    expect(result?.data?.error).toBe("INVALID_PARAMS");
    expect(String(result?.text)).toContain("pump.fun token mint");
    expect(pumpfun.execute).not.toHaveBeenCalled();
  });

  it("rejects pump.fun buys with a malformed mint before confirmation", async () => {
    const { runtime, service } = createService();
    const pumpfun = handler(
      "pumpfun",
      "pump.fun",
      "pump.fun-solana",
      "solana",
      ["pump_fun_buy"],
    );
    service.registerChainHandler(pumpfun);

    for (const toToken of [
      "BONK",
      "0x123",
      "111111111111111111111111111111111",
    ]) {
      const result = await run(runtime, {
        subaction: "pump_fun_buy",
        chain: "pumpfun",
        toToken,
        amount: "0.1",
        mode: "execute",
      });

      expect(result?.success).toBe(false);
      expect(result?.data?.error).toBe("INVALID_PARAMS");
      expect(String(result?.text)).toContain(
        "toToken must be a valid pump.fun token mint address.",
      );
    }
    expect(pumpfun.execute).not.toHaveBeenCalled();
  });

  it("does not execute when LLM sets confirmed:true without a user yes reply", async () => {
    const { runtime, service } = createService();
    const base = handler("base", "Base", "8453", "evm");
    service.registerChainHandler(base);

    const result = await run(runtime, {
      subaction: "transfer",
      chain: "base",
      amount: "0.5",
      recipient: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
      mode: "execute",
      confirmed: true,
    });

    expect(result?.data?.requiresConfirmation).toBe(true);
    expect(base.execute).not.toHaveBeenCalled();
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

  it("dispatches mode=simulate to handler.simulate without calling execute or the confirmation gate", async () => {
    const { runtime, service } = createService();
    const solana = handler(
      "solana",
      "Solana",
      "solana-mainnet",
      "solana",
      ["transfer", "swap"],
      ["swap"],
    );
    service.registerChainHandler(solana);

    // run(), not runConfirmed(): mode=simulate must skip the confirmation
    // gate entirely (it never signs or broadcasts), so a single turn with no
    // prior "yes" reply must still reach the handler.
    const result = await run(runtime, {
      subaction: "swap",
      chain: "solana",
      fromToken: "SOL",
      toToken: USDC_MINT,
      amount: "1",
      mode: "simulate",
    });

    expect(result?.success).toBe(true);
    expect(result?.data?.status).toBe("simulated");
    expect(result?.text).toBe(
      "Simulated swap on solana: ok, ~1000 compute units.",
    );
    expect(solana.simulate).toHaveBeenCalledTimes(1);
    expect(solana.simulate).toHaveBeenCalledWith(
      expect.objectContaining({ subaction: "swap", mode: "simulate" }),
      expect.any(Object),
    );
    expect(solana.execute).not.toHaveBeenCalled();
  });

  it("renders a distinct 'would fail' line for a simulate result with success:false", async () => {
    const { runtime, service } = createService();
    const failingSimulate = vi.fn(
      async (params: WalletRouterParams): Promise<WalletRouterExecution> => ({
        status: "simulated",
        chain: "solana",
        chainId: "solana-mainnet",
        subaction: params.subaction,
        dryRun: params.dryRun,
        mode: params.mode,
        amount: params.amount,
        fromToken: params.fromToken,
        toToken: params.toToken,
        simulation: {
          success: false,
          err: "InstructionError",
          logs: ["Program log: failed", "Program log: insufficient funds"],
          unitsConsumed: 500,
          route: [],
          requestedSlippageBps: null,
          effectiveSlippageBps: null,
          summary: { inToken: "SOL", outToken: "USDC" },
        },
      }),
    );
    const solana: WalletChainHandler = {
      chain: "solana",
      name: "Solana",
      chainId: "solana-mainnet",
      aliases: ["solana", "sol"],
      supportedActions: ["swap"],
      tokens: [],
      signer: { required: true, kind: "solana", source: "test" },
      dryRun: { supported: true, supportedActions: ["swap"] },
      simulation: { supported: true, supportedActions: ["swap"] },
      execute: vi.fn(),
      simulate: failingSimulate,
    };
    service.registerChainHandler(solana);

    const result = await run(runtime, {
      subaction: "swap",
      chain: "solana",
      fromToken: "SOL",
      toToken: USDC_MINT,
      amount: "1",
      mode: "simulate",
    });

    expect(result?.success).toBe(true);
    expect(result?.text).toContain("would fail");
    expect(result?.text).toContain("InstructionError");
    expect(result?.text).toContain("Program log: failed");
    expect(solana.execute).not.toHaveBeenCalled();
  });

  it("returns a typed SIMULATION_UNSUPPORTED failure for a handler that never opted in, without fabricating a prepared result", async () => {
    const { runtime, service } = createService();
    const base = handler("base", "Base", "8453", "evm"); // no simulateActions passed
    service.registerChainHandler(base);

    const result = await run(runtime, {
      subaction: "swap",
      chain: "base",
      fromToken: "ETH",
      toToken: USDC_EVM,
      amount: "1",
      mode: "simulate",
    });

    expect(result?.success).toBe(false);
    expect(result?.data?.error).toBe("SIMULATION_UNSUPPORTED");
    expect(String(result?.text)).toContain("does not support simulation");
    expect(result?.data?.status).toBeUndefined();
    expect(base.execute).not.toHaveBeenCalled();
  });
});
