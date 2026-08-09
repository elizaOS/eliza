/**
 * Regression tests for confirmed-slippage threading on the EVM swap and
 * bridge paths. The wallet router binds `slippageBps` into the confirmation
 * pending key, but the EVM execution path dropped it: `executeSwap` called
 * `SwapAction.swap` without it (so quotes escalated 1% -> 1.5% -> 2%
 * regardless of the confirmed value) and both `routeEvmBridge` quote sites
 * hardcoded `DEFAULT_SLIPPAGE_PERCENT`. These tests pin the confirmed value
 * reaching the Li.Fi quote layer and the defaults holding when no slippage
 * was stated. It also proves that an explicitly bounded swap cannot select a
 * Bebop quote whose request has no enforceable tolerance, and that Li.Fi's
 * exchange-rate refresh hook fails closed instead of widening a confirmed
 * bridge tolerance. Network boundaries (Li.Fi `getRoutes`/`executeRoute`,
 * Bebop/KyberSwap fetch) are mocked; the routing and slippage math under test
 * is the real production code. Also covers the registry swap path forwarding
 * and the parse-layer contract: `SwapParamsSchema`/`BridgeParamsSchema` must
 * accept and bounds-check `slippageBps` so the field cannot be silently
 * stripped between the router boundary and execution.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { ExecutionOptions } from "@lifi/sdk";
import { arbitrum, base } from "viem/chains";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalletBackendService } from "../../../../services/wallet-backend-service.js";
import type { WalletChainHandler, WalletRouterContext } from "../../../../types/wallet-router.js";
import { registerDefaultWalletChainHandlers } from "../../../registry";
import { SwapAction } from "../../actions/swap";
import { BridgeAction, routeEvmBridge } from "../../bridge-router";
import { createEvmWalletChainHandler } from "../../chain-handler";
import { NATIVE_TOKEN_ADDRESS } from "../../constants";
import type { WalletProvider } from "../../providers/wallet";
import { parseBridgeParams, parseSwapParams } from "../../types";

const { executeRouteMock, getRoutesMock, initWalletProviderMock } = vi.hoisted(() => ({
  executeRouteMock: vi.fn(),
  getRoutesMock: vi.fn(),
  initWalletProviderMock: vi.fn(),
}));

vi.mock("@lifi/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lifi/sdk")>();
  return { ...actual, executeRoute: executeRouteMock, getRoutes: getRoutesMock };
});

vi.mock("../../providers/wallet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../providers/wallet")>();
  return { ...actual, initWalletProvider: initWalletProviderMock };
});

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const HASH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function createFakeWalletProvider(): WalletProvider {
  return {
    chains: { base, arbitrum },
    getSupportedChains: () => ["base", "arbitrum"],
    getChainConfigs: (name: string) => (name === "arbitrum" ? arbitrum : base),
    getWalletClient: () => ({
      account: { address: ACCOUNT },
      getAddresses: async () => [ACCOUNT],
      sendTransaction: vi.fn(async () => HASH),
    }),
    getPublicClient: () => ({
      readContract: vi.fn(async () => 6),
    }),
  } as unknown as WalletProvider;
}

const context = {
  runtime: {} as IAgentRuntime,
  walletBackend: null,
  walletServices: [],
  tokenDataService: null,
} satisfies WalletRouterContext;

/** Slippage fraction seen by each Li.Fi `getRoutes` call, in call order. */
function quotedSlippages(): number[] {
  return getRoutesMock.mock.calls.map(
    (call: unknown[]) => (call[0] as { options?: { slippage?: number } }).options?.slippage ?? -1
  );
}

function requestedUrls(): string[] {
  return vi.mocked(fetch).mock.calls.map(([url]) => String(url));
}

beforeEach(() => {
  executeRouteMock.mockReset();
  getRoutesMock.mockReset();
  getRoutesMock.mockResolvedValue({ routes: [] });
  initWalletProviderMock.mockReset();
  initWalletProviderMock.mockImplementation(async () => createFakeWalletProvider());
  // Bebop/KyberSwap quote fetches fail fast; the Li.Fi quote path (mocked
  // getRoutes) is the slippage witness for both swap and bridge.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, status: 500, statusText: "stubbed" }))
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("EVM confirmed slippage threading", () => {
  it("forwards confirmed slippageBps from the wallet router to SwapAction.swap", async () => {
    const swapSpy = vi.spyOn(SwapAction.prototype, "swap").mockResolvedValue({
      hash: HASH,
      from: ACCOUNT,
      to: USDC,
      value: 0n,
      data: "0x",
      chainId: base.id,
    });
    const handler = createEvmWalletChainHandler("base", base, {
      walletProvider: createFakeWalletProvider(),
    });

    await handler.executeSwap(
      {
        subaction: "swap",
        chain: "base",
        fromToken: "ETH",
        toToken: USDC,
        amount: "1",
        slippageBps: 10,
        mode: "execute",
        dryRun: false,
      },
      context
    );

    expect(swapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: "base",
        fromToken: NATIVE_TOKEN_ADDRESS,
        toToken: USDC,
        amount: "1",
        slippageBps: 10,
      })
    );
  });

  it("quotes the swap at exactly the confirmed slippage (10 bps -> 0.001)", async () => {
    const action = new SwapAction(createFakeWalletProvider());

    await expect(
      action.swap({
        chain: "base",
        fromToken: NATIVE_TOKEN_ADDRESS,
        toToken: USDC,
        amount: "1",
        slippageBps: 10,
      })
    ).rejects.toThrow("No routes found");

    expect(quotedSlippages()).toEqual([0.001]);
    expect(requestedUrls().some((url) => url.includes("api.bebop.xyz"))).toBe(false);
  });

  it("keeps the default 1% first quote when no swap slippage was stated", async () => {
    const action = new SwapAction(createFakeWalletProvider());

    await expect(
      action.swap({
        chain: "base",
        fromToken: NATIVE_TOKEN_ADDRESS,
        toToken: USDC,
        amount: "1",
      })
    ).rejects.toThrow("No routes found");

    expect(quotedSlippages()).toEqual([0.01]);
    expect(requestedUrls().some((url) => url.includes("api.bebop.xyz"))).toBe(true);
  });

  it("rejects a Li.Fi bridge rate refresh when the user confirmed an explicit tolerance", async () => {
    let executionOptions: ExecutionOptions | undefined;
    getRoutesMock.mockResolvedValue({
      routes: [{ steps: [{ tool: "lifi" }] }],
    });
    executeRouteMock.mockImplementation(async (_route: unknown, options: ExecutionOptions) => {
      executionOptions = options;
      throw new Error("stop after capturing execution options");
    });

    const action = new BridgeAction(createFakeWalletProvider());
    await expect(
      action.bridge({
        fromChain: "base",
        toChain: "arbitrum",
        fromToken: NATIVE_TOKEN_ADDRESS,
        toToken: NATIVE_TOKEN_ADDRESS,
        amount: "0.5",
        slippageBps: 10,
      })
    ).rejects.toThrow("stop after capturing execution options");

    const hook = executionOptions?.acceptExchangeRateUpdateHook;
    if (!hook) throw new Error("acceptExchangeRateUpdateHook was not configured");
    await expect(
      hook({
        oldToAmount: "1000000",
        newToAmount: "990000",
        toToken: { decimals: 6, symbol: "USDC" },
      })
    ).resolves.toBe(false);
  });

  it("preserves the existing rate-refresh policy when bridge slippage was not explicit", async () => {
    let executionOptions: ExecutionOptions | undefined;
    getRoutesMock.mockResolvedValue({
      routes: [{ steps: [{ tool: "lifi" }] }],
    });
    executeRouteMock.mockImplementation(async (_route: unknown, options: ExecutionOptions) => {
      executionOptions = options;
      throw new Error("stop after capturing execution options");
    });

    const action = new BridgeAction(createFakeWalletProvider());
    await expect(
      action.bridge({
        fromChain: "base",
        toChain: "arbitrum",
        fromToken: NATIVE_TOKEN_ADDRESS,
        toToken: NATIVE_TOKEN_ADDRESS,
        amount: "0.5",
      })
    ).rejects.toThrow("stop after capturing execution options");

    const hook = executionOptions?.acceptExchangeRateUpdateHook;
    if (!hook) throw new Error("acceptExchangeRateUpdateHook was not configured");
    await expect(
      hook({
        oldToAmount: "1000000",
        newToAmount: "990000",
        toToken: { decimals: 6, symbol: "USDC" },
      })
    ).resolves.toBe(true);
  });

  it("quotes the bridge at exactly the confirmed slippage (50 bps -> 0.005)", async () => {
    await expect(
      routeEvmBridge(
        {
          subaction: "bridge",
          chain: "base",
          toChain: "arbitrum",
          fromToken: NATIVE_TOKEN_ADDRESS,
          toToken: NATIVE_TOKEN_ADDRESS,
          amount: "0.5",
          slippageBps: 50,
          mode: "execute",
          dryRun: false,
        },
        context,
        "base",
        base
      )
    ).rejects.toThrow("No bridge routes found");

    expect(quotedSlippages()).toEqual([0.005]);
  });

  it("keeps the default bridge slippage when none was stated", async () => {
    await expect(
      routeEvmBridge(
        {
          subaction: "bridge",
          chain: "base",
          toChain: "arbitrum",
          fromToken: NATIVE_TOKEN_ADDRESS,
          toToken: NATIVE_TOKEN_ADDRESS,
          amount: "0.5",
          mode: "execute",
          dryRun: false,
        },
        context,
        "base",
        base
      )
    ).rejects.toThrow("No bridge routes found");

    expect(quotedSlippages()).toEqual([0.01]);
  });

  it("threads confirmed slippage through the prepare-mode bridge quote", async () => {
    const result = await routeEvmBridge(
      {
        subaction: "bridge",
        chain: "base",
        toChain: "arbitrum",
        fromToken: NATIVE_TOKEN_ADDRESS,
        toToken: NATIVE_TOKEN_ADDRESS,
        amount: "0.5",
        slippageBps: 50,
        mode: "prepare",
        dryRun: false,
      },
      context,
      "base",
      base
    );

    expect(result.status).toBe("prepared");
    expect(quotedSlippages()).toEqual([0.005]);
  });

  it("forwards confirmed slippageBps through the registry EVM swap path", async () => {
    const swapSpy = vi.spyOn(SwapAction.prototype, "swap").mockResolvedValue({
      hash: HASH,
      from: ACCOUNT,
      to: USDC,
      value: 0n,
      data: "0x",
      chainId: base.id,
    });
    const handlers = new Map<string, WalletChainHandler>();
    const service = {
      registerChainHandler: (handler: WalletChainHandler) => handlers.set(handler.chain, handler),
    } as unknown as WalletBackendService;
    const runtime = {
      character: { settings: { chains: { evm: ["base"] } } },
      getSetting: (key: string) => (key === "SOLANA_NO_ACTIONS" ? "true" : undefined),
    } as unknown as IAgentRuntime;

    registerDefaultWalletChainHandlers(service, runtime);
    const handler = handlers.get("base");
    if (!handler) throw new Error("base handler was not registered");

    await handler.execute(
      {
        subaction: "swap",
        chain: "base",
        fromToken: "ETH",
        toToken: USDC,
        amount: "1",
        slippageBps: 25,
        mode: "execute",
        dryRun: false,
      },
      context
    );

    expect(swapSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        chain: "base",
        fromToken: NATIVE_TOKEN_ADDRESS,
        toToken: USDC,
        amount: "1",
        slippageBps: 25,
      })
    );
  });
});

describe("slippageBps parse-layer acceptance", () => {
  const swapInput = {
    chain: "base",
    fromToken: NATIVE_TOKEN_ADDRESS,
    toToken: USDC,
    amount: "1",
  };
  const bridgeInput = {
    fromChain: "base",
    toChain: "arbitrum",
    fromToken: NATIVE_TOKEN_ADDRESS,
    toToken: NATIVE_TOKEN_ADDRESS,
    amount: "0.5",
  };

  it("preserves a valid slippageBps through parseSwapParams and parseBridgeParams", () => {
    expect(parseSwapParams({ ...swapInput, slippageBps: 50 }).slippageBps).toBe(50);
    expect(parseBridgeParams({ ...bridgeInput, slippageBps: 50 }).slippageBps).toBe(50);
  });

  it("rejects negative, fractional, and over-limit slippageBps", () => {
    for (const bad of [-1, 10.5, 10_001]) {
      expect(() => parseSwapParams({ ...swapInput, slippageBps: bad })).toThrow();
      expect(() => parseBridgeParams({ ...bridgeInput, slippageBps: bad })).toThrow();
    }
  });
});
