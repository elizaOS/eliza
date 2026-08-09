/**
 * Regression tests for the wallet bridge recipient gap. The
 * GHSA-7qxr-x6cg-r9cc recipient-authorization guard in `runWalletRouter`
 * wrapped only `transfer`, so a bridge recipient (which `routeEvmBridge`
 * maps to the Li.Fi destination `toAddress`) was never checked against the
 * user message, and the bridge confirmation preview omitted the destination
 * entirely: an injected recipient could be bridged to after a blind "yes".
 *
 * Content-driven bridges (recipient on `message.content`) require the address
 * to appear in the user text, same as transfer. Planner-path bridges that put
 * the recipient only in `HandlerOptions.parameters` are a known boundary of the
 * existing authorization model (`collectExplicitRecipients` treats those as
 * user-supplied); the confirmation preview that shows the destination is the
 * effective defense on that path. Do not claim the guard blocks planner-
 * injected recipients.
 *
 * No live model, network, or chain; the routing/gating code under test is the
 * real production path.
 */
import type {
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { WalletBackendService } from "../../services/wallet-backend-service";
import type {
  WalletChainHandler,
  WalletRouterExecution,
  WalletRouterParams,
} from "../../types/wallet-router";
import { walletRouterAction } from "../wallet-action";

const UNSTATED_RECIPIENT = "0x00000000000000000000000000000000deadbeef";
const SOLANA_RECIPIENT = "9xQeWvG816bUx9EPfWJXn4xHLh1BaK7Z7QXDXuGpS9SW";

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
  return runtime as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    entityId: "00000000-0000-0000-0000-000000000002",
    agentId: "00000000-0000-0000-0000-000000000003",
    roomId: "00000000-0000-0000-0000-000000000004",
    content: { text },
    createdAt: Date.now(),
  } as Memory;
}

function evmHandler(
  chain: string,
  name: string,
  chainId: string,
): WalletChainHandler {
  const supportedActions: WalletChainHandler["supportedActions"] = [
    "transfer",
    "swap",
    "bridge",
  ];
  const execute = vi.fn(
    async (params: WalletRouterParams): Promise<WalletRouterExecution> => ({
      status: "submitted",
      chain,
      chainId,
      subaction: params.subaction,
      dryRun: false,
      mode: params.mode,
      transactionHash: "0xtest",
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
    aliases: [chain, name, chainId],
    supportedActions,
    tokens: [
      {
        symbol: "ETH",
        address: "0x0000000000000000000000000000000000000000",
        decimals: 18,
        native: true,
      },
    ],
    signer: { required: true, kind: "evm", source: "test" },
    dryRun: { supported: true, supportedActions },
    execute,
  };
}

function walletRuntime(): {
  runtime: IAgentRuntime;
  service: WalletBackendService;
} {
  const runtime = createRuntime();
  const service = new WalletBackendService(runtime);
  vi.mocked(runtime.getService).mockImplementation((name: string) =>
    name === WalletBackendService.serviceType ? service : null,
  );
  return { runtime, service };
}

function promptCapture(): {
  callback: HandlerCallback;
  prompts: string[];
} {
  const prompts: string[] = [];
  const callback: HandlerCallback = async (content) => {
    if (content?.text) prompts.push(content.text);
    return [];
  };
  return { callback, prompts };
}

const bridgeParams = {
  subaction: "bridge",
  chain: "base",
  toChain: "arbitrum",
  fromToken: "ETH",
  amount: "0.5",
  recipient: UNSTATED_RECIPIENT,
  mode: "execute",
};

function contentDrivenMessage(
  text: string,
  params: Record<string, unknown>,
): Memory {
  const mem = message(text);
  mem.content = { ...mem.content, ...params };
  return mem;
}

describe("wallet bridge recipient guard", () => {
  it("rejects a content-driven bridge whose recipient is absent from the user message", async () => {
    const { runtime, service } = walletRuntime();
    const base = evmHandler("base", "Base", "8453");
    service.registerChainHandler(base);

    const rejected = await walletRouterAction.handler(
      runtime,
      contentDrivenMessage("please bridge 0.5 ETH from base to arbitrum", {
        action: "bridge",
        chain: "base",
        toChain: "arbitrum",
        fromToken: "ETH",
        amount: "0.5",
        recipient: UNSTATED_RECIPIENT,
        mode: "execute",
      }),
      undefined,
      undefined,
    );

    expect(rejected?.success).toBe(false);
    expect(rejected?.data?.error).toBe("INVALID_PARAMS");
    expect(String(rejected?.text)).toContain(
      "must appear explicitly in the current user message",
    );
    expect(base.execute).not.toHaveBeenCalled();
  });

  it("accepts a content-driven bridge whose recipient appears in the user message", async () => {
    const { runtime, service } = walletRuntime();
    const base = evmHandler("base", "Base", "8453");
    service.registerChainHandler(base);

    const first = await walletRouterAction.handler(
      runtime,
      contentDrivenMessage(
        `please bridge 0.5 ETH from base to arbitrum to ${UNSTATED_RECIPIENT}`,
        {
          action: "bridge",
          chain: "base",
          toChain: "arbitrum",
          fromToken: "ETH",
          amount: "0.5",
          recipient: UNSTATED_RECIPIENT,
          mode: "execute",
        },
      ),
      undefined,
      undefined,
    );

    expect(first?.data?.requiresConfirmation).toBe(true);
    expect(base.execute).not.toHaveBeenCalled();
  });

  it("documents planner-path boundary: parameters.recipient authorizes itself; preview shows destination before execute", async () => {
    // Known boundary (pre-existing for transfer, extended here to bridge):
    // collectExplicitRecipients treats HandlerOptions.parameters.recipient as
    // authorized even when the user message never names it. The confirmation
    // preview disclosing the destination is the effective defense on this path.
    const { runtime, service } = walletRuntime();
    const base = evmHandler("base", "Base", "8453");
    service.registerChainHandler(base);
    const { callback, prompts } = promptCapture();

    const first = await walletRouterAction.handler(
      runtime,
      message("bridge 0.5 ETH from base to arbitrum"),
      undefined,
      { parameters: bridgeParams } as HandlerOptions,
      callback,
    );
    expect(first?.data?.requiresConfirmation).toBe(true);
    expect(base.execute).not.toHaveBeenCalled();

    const prompt = prompts.join("\n");
    expect(prompt).toContain("Bridge 0.5 ETH from base to arbitrum");
    expect(prompt).toContain(UNSTATED_RECIPIENT);

    const second = await walletRouterAction.handler(
      runtime,
      message("yes"),
      undefined,
      { parameters: bridgeParams } as HandlerOptions,
      callback,
    );
    expect(second?.success).toBe(true);
    expect(base.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        subaction: "bridge",
        recipient: UNSTATED_RECIPIENT,
      }),
      expect.any(Object),
    );
  });

  it("omits the destination clause from the bridge preview when no recipient is set", async () => {
    const { runtime, service } = walletRuntime();
    const base = evmHandler("base", "Base", "8453");
    service.registerChainHandler(base);
    const { callback, prompts } = promptCapture();

    const selfBridgeParams = {
      subaction: "bridge",
      chain: "base",
      toChain: "arbitrum",
      fromToken: "ETH",
      amount: "0.5",
      mode: "execute",
    };
    const first = await walletRouterAction.handler(
      runtime,
      message("bridge 0.5 ETH from base to arbitrum"),
      undefined,
      { parameters: selfBridgeParams } as HandlerOptions,
      callback,
    );

    expect(first?.data?.requiresConfirmation).toBe(true);
    const prompt = prompts.join("\n");
    expect(prompt).toContain(
      "Bridge 0.5 ETH from base to arbitrum with default slippage?",
    );
    expect(prompt).not.toContain("undefined");
    expect(base.execute).not.toHaveBeenCalled();
  });

  it("still rejects a content-driven transfer whose recipient is absent from the user message", async () => {
    const { runtime, service } = walletRuntime();
    const base = evmHandler("base", "Base", "8453");
    service.registerChainHandler(base);

    const rejected = await walletRouterAction.handler(
      runtime,
      contentDrivenMessage("please transfer 0.5 ETH for me", {
        action: "transfer",
        chain: "base",
        amount: "0.5",
        recipient: UNSTATED_RECIPIENT,
      }),
      undefined,
      undefined,
    );

    expect(rejected?.success).toBe(false);
    expect(rejected?.data?.error).toBe("INVALID_PARAMS");
    expect(String(rejected?.text)).toContain(
      "must appear explicitly in the current user message",
    );
    expect(base.execute).not.toHaveBeenCalled();
  });

  it("rejects a content-driven bridge with a Solana-format recipient absent from the user message", async () => {
    const { runtime, service } = walletRuntime();
    const base = evmHandler("base", "Base", "8453");
    service.registerChainHandler(base);

    const rejected = await walletRouterAction.handler(
      runtime,
      contentDrivenMessage("please bridge 0.5 ETH from base to arbitrum", {
        action: "bridge",
        chain: "base",
        toChain: "arbitrum",
        fromToken: "ETH",
        amount: "0.5",
        recipient: SOLANA_RECIPIENT,
        mode: "execute",
      }),
      undefined,
      undefined,
    );

    expect(rejected?.success).toBe(false);
    expect(rejected?.data?.error).toBe("INVALID_PARAMS");
    expect(String(rejected?.text)).toContain(
      "must appear explicitly in the current user message",
    );
    expect(base.execute).not.toHaveBeenCalled();
  });

  it("accepts a content-driven bridge whose Solana-format recipient appears in the user message", async () => {
    const { runtime, service } = walletRuntime();
    const base = evmHandler("base", "Base", "8453");
    service.registerChainHandler(base);

    const first = await walletRouterAction.handler(
      runtime,
      contentDrivenMessage(
        `please bridge 0.5 ETH from base to arbitrum to ${SOLANA_RECIPIENT}`,
        {
          action: "bridge",
          chain: "base",
          toChain: "arbitrum",
          fromToken: "ETH",
          amount: "0.5",
          recipient: SOLANA_RECIPIENT,
          mode: "execute",
        },
      ),
      undefined,
      undefined,
    );

    expect(first?.data?.requiresConfirmation).toBe(true);
    expect(base.execute).not.toHaveBeenCalled();
  });
});
