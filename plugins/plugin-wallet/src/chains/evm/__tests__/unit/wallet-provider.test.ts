import type { IAgentRuntime } from "@elizaos/core";
import { mainnet } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChainRpcConfig, WalletProvider } from "../../providers/wallet";

function createRuntime(): IAgentRuntime {
  return {
    getCache: vi.fn(),
    setCache: vi.fn(),
  } as unknown as IAgentRuntime;
}

function getHeader(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

describe("WalletProvider managed RPC fallback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("falls back to the chain default RPC when Eliza Cloud returns malformed JSON", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("gateway blew up", {
          status: 502,
          headers: {
            "Content-Type": "application/json",
          },
        })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: "0xde0b6b3a7640000",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
            },
          }
        )
      );

    vi.stubGlobal("fetch", fetchMock);

    const provider = new WalletProvider(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      createRuntime(),
      { mainnet },
      {
        mainnet: {
          providerName: "elizacloud",
          rpcUrl: "https://cloud.example.test/api/v1/proxy/evm-rpc/mainnet",
          headers: { Authorization: "Bearer cloud-key" },
        } satisfies ChainRpcConfig,
      }
    );

    const balance = await provider.getWalletBalanceForChain("mainnet");

    expect(balance).toBe("1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://cloud.example.test/api/v1/proxy/evm-rpc/mainnet"
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(mainnet.rpcUrls.default.http[0]);
    expect(getHeader(fetchMock.mock.calls[0]?.[1], "authorization")).toBe("Bearer cloud-key");
    expect(getHeader(fetchMock.mock.calls[1]?.[1], "authorization")).toBeNull();
  });

  it("falls back to the chain default RPC when the Eliza Cloud request throws", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        })
      );

    vi.stubGlobal("fetch", fetchMock);

    const provider = new WalletProvider(
      "0x1111111111111111111111111111111111111111111111111111111111111111",
      createRuntime(),
      { mainnet },
      {
        mainnet: {
          providerName: "elizacloud",
          rpcUrl: "https://cloud.example.test/api/v1/proxy/evm-rpc/mainnet",
          headers: { Authorization: "Bearer cloud-key" },
        } satisfies ChainRpcConfig,
      }
    );

    const balance = await provider.getWalletBalanceForChain("mainnet");

    expect(balance).toBe("0");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(mainnet.rpcUrls.default.http[0]);
    expect(getHeader(fetchMock.mock.calls[1]?.[1], "authorization")).toBeNull();
  });
});
