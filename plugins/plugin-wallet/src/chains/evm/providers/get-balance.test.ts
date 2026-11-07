import type { IAgentRuntime, Memory } from "@elizaos/core";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenBalanceProvider } from "./get-balance";

const PRIVATE_KEY = generatePrivateKey();
const ADDRESS = privateKeyToAccount(PRIVATE_KEY).address;

function stubRuntime(intent: string): IAgentRuntime {
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    character: { name: "Eliza", bio: [], settings: { chains: { evm: ["mainnet"] } } },
    getSetting: (key: string) => (key === "EVM_PRIVATE_KEY" ? PRIVATE_KEY : undefined),
    useModel: async () => intent,
  } as unknown as IAgentRuntime;
}

function message(text: string): Memory {
  return { content: { text } } as Memory;
}

type RpcRequest = { id: number; method: string; params: unknown[] };

function stubNetwork(
  token: { address: string; symbol: string; decimals: number },
  ethCallResult = "0x"
) {
  const rpcMethods: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("li.quest")) {
        return new Response(
          JSON.stringify({ chainId: 1, name: token.symbol, priceUSD: "0", ...token }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
      const reply = (request: RpcRequest) => {
        rpcMethods.push(request.method);
        if (request.method === "eth_getBalance") {
          return { jsonrpc: "2.0", id: request.id, result: "0x1bc16d674ec80000" };
        }
        if (request.method === "eth_call") {
          return { jsonrpc: "2.0", id: request.id, result: ethCallResult };
        }
        return { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unsupported" } };
      };
      return new Response(JSON.stringify(Array.isArray(body) ? body.map(reply) : reply(body)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
  return rpcMethods;
}

describe("tokenBalanceProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the native coin balance when asked for ETH", async () => {
    const rpcMethods = stubNetwork({
      address: "0x0000000000000000000000000000000000000000",
      symbol: "ETH",
      decimals: 18,
    });

    const result = await tokenBalanceProvider.get(
      stubRuntime("token: ETH\nchain: mainnet"),
      message("what is my ETH balance on mainnet?"),
      { values: {}, data: {}, text: "" }
    );

    expect(result.text).toBe(`ETH balance on mainnet for ${ADDRESS}: 2`);
    expect(result.values).toEqual({
      token: "ETH",
      chain: "mainnet",
      balance: "2",
      hasBalance: "true",
    });
    expect(rpcMethods).toEqual(["eth_getBalance"]);
  });

  it("reports an ERC-20 balance from balanceOf", async () => {
    const rpcMethods = stubNetwork(
      { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
      "0x000000000000000000000000000000000000000000000000000000000016e360"
    );

    const result = await tokenBalanceProvider.get(
      stubRuntime("token: USDC\nchain: mainnet"),
      message("what is my USDC balance on mainnet?"),
      { values: {}, data: {}, text: "" }
    );

    expect(result.text).toBe(`USDC balance on mainnet for ${ADDRESS}: 1.5`);
    expect(rpcMethods).toEqual(["eth_call"]);
  });
});
