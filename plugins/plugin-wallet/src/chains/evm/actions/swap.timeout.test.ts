/**
 * EVM swap fetch deadlines — proves the production SwapAction aborts
 * on timeout via mocked hanging fetch, covering Bebop/Kyber routes.
 */
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_EVM_SWAP_FETCH_TIMEOUT_MS, SwapAction } from "./swap";

function createMockWalletProvider() {
  const chainConfig = {
    id: 1,
    name: "Ethereum",
    nativeCurrency: { symbol: "ETH", decimals: 18, name: "Ether" },
    rpcUrls: { default: { http: ["https://rpc.test"] } },
    blockExplorers: { default: { url: "https://etherscan.io" } },
  };
  return {
    chains: { mainnet: chainConfig },
    getChainConfigs: () => chainConfig,
    getWalletClient: () => ({
      account: { address: "0x1111111111111111111111111111111111111111" },
      getAddresses: async () => ["0x1111111111111111111111111111111111111111" as const],
      chain: { id: 1 },
      sendTransaction: async () => "0xhash" as const,
    }),
    getPublicClient: () => ({
      readContract: async () => 18,
      waitForTransactionReceipt: async () => ({ status: "success" }),
    }),
  } as unknown as import("../providers/wallet").WalletProvider;
}

describe("SwapAction fetch timeout", () => {
  it("exposes the documented 10s budget", () => {
    expect(DEFAULT_EVM_SWAP_FETCH_TIMEOUT_MS).toBe(10_000);
  });

  it("aborts a stalled Bebop quote at the deadline", async () => {
    const svc = new SwapAction(createMockWalletProvider());
    const orig = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing bebop");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await (
        svc as unknown as {
          getBebopQuote: (a: string, p: unknown, d: number) => Promise<unknown>;
        }
      ).getBebopQuote(
        "0x1111111111111111111111111111111111111111",
        {
          chain: "mainnet",
          fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          amount: "1",
        },
        6
      );
      expect(result).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("api.bebop.xyz"),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_EVM_SWAP_FETCH_TIMEOUT_MS);
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });

  it("aborts a stalled Kyber quote at the deadline", async () => {
    const svc = new SwapAction(createMockWalletProvider());
    const orig = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing kyber");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await (
        svc as unknown as {
          getKyberSwapQuote: (a: string, p: unknown, d: number, s: number) => Promise<unknown>;
        }
      ).getKyberSwapQuote(
        "0x1111111111111111111111111111111111111111",
        {
          chain: "mainnet",
          fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          amount: "1",
        },
        6,
        0.01
      );
      expect(result).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("aggregator-api.kyberswap.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_EVM_SWAP_FETCH_TIMEOUT_MS);
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });

  it("aborts a stalled Kyber build at the deadline", async () => {
    const svc = new SwapAction(createMockWalletProvider());
    const orig = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => orig(10));
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const sig = init?.signal as AbortSignal | undefined;
        if (!sig) throw new Error("signal missing build");
        sig.addEventListener("abort", () => reject(sig.reason), { once: true });
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await expect(
        (
          svc as unknown as {
            executeKyberSwapQuote: (q: unknown, p: unknown) => Promise<unknown>;
          }
        ).executeKyberSwapQuote(
          {
            swapData: {
              routeSummary: { amountOut: "1000" },
              routerAddress: "0x1111111111111111111111111111111111111111",
              chainSlug: "ethereum",
              fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
              amountIn: "1000000",
              slippageBps: 100,
              fromAddress: "0x1111111111111111111111111111111111111111",
            },
          },
          { chain: "mainnet" }
        )
      ).rejects.toMatchObject({ name: "TimeoutError" });
      expect(spy).toHaveBeenCalledWith(
        expect.stringContaining("aggregator-api.kyberswap.com"),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
      expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_EVM_SWAP_FETCH_TIMEOUT_MS);
    } finally {
      globalThis.fetch = prev;
      vi.restoreAllMocks();
    }
  });

  it("sends the abort signal and succeeds on a fast upstream", async () => {
    const svc = new SwapAction(createMockWalletProvider());
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!init?.signal) throw new Error("signal missing success");
      return Response.json({
        routes: [
          {
            quote: {
              buyTokens: {
                "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2": { minimumAmount: "900" },
              },
              tx: {
                data: "0x",
                from: "0x1111111111111111111111111111111111111111",
                to: "0x2222222222222222222222222222222222222222",
                value: "0",
                gas: "100000",
                gasPrice: "1000000000",
              },
              approvalTarget: "0x3333333333333333333333333333333333333333",
            },
          },
        ],
      });
    });
    const prev = globalThis.fetch;
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      const result = await (
        svc as unknown as {
          getBebopQuote: (a: string, p: unknown, d: number) => Promise<unknown>;
        }
      ).getBebopQuote(
        "0x1111111111111111111111111111111111111111",
        {
          chain: "mainnet",
          fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          amount: "1",
        },
        6
      );
      expect((result as { aggregator: string }).aggregator).toBe("bebop");
      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    } finally {
      globalThis.fetch = prev;
    }
  });
});
