/** Validate balances over real JSON-RPC transport without signing or funded keys. */
import { once } from "node:events";
import http from "node:http";
import { expect, it, vi } from "vitest";
import { fetchEvmNativeBalanceViaRpc } from "../read.ts";
import { fetchResolvedEvmBalances } from "./evm-balances.ts";

it("reads valid balances and rejects missing or malformed provider results", async () => {
  let payload: unknown = { jsonrpc: "2.0", id: 1, result: "0xde0b6b3a7640000" };
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.method !== "eth_getBalance") {
      res.writeHead(400).end();
      return;
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const rpc = `http://127.0.0.1:${address.port}`;
  try {
    expect(
      Number(
        await fetchEvmNativeBalanceViaRpc(
          rpc,
          "0x1111111111111111111111111111111111111111",
        ),
      ),
    ).toBe(1);
    for (const result of [undefined, null, 0, "", "invalid", "-1"]) {
      payload = { jsonrpc: "2.0", id: 1, result };
      await expect(
        fetchEvmNativeBalanceViaRpc(
          rpc,
          "0x1111111111111111111111111111111111111111",
        ),
      ).rejects.toMatchObject({ code: "WALLET_RPC_INVALID_BALANCE" });
    }
    payload = null;
    await expect(
      fetchEvmNativeBalanceViaRpc(
        rpc,
        "0x1111111111111111111111111111111111111111",
      ),
    ).rejects.toMatchObject({ code: "WALLET_RPC_INVALID_BALANCE" });
    payload = { jsonrpc: "2.0", id: 1, result: "0x0" };
    expect(
      Number(
        await fetchEvmNativeBalanceViaRpc(
          rpc,
          "0x1111111111111111111111111111111111111111",
        ),
      ),
    ).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it("fails the chain instead of dropping a token whose Alchemy metadata cannot be read", async () => {
  const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const weth = "0x4200000000000000000000000000000000000006";
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes(".g.alchemy.com/")) return new Response("{}");
    const request = JSON.parse(String(init?.body));
    const reply = (result: unknown) =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
    if (request.method === "eth_getBalance") return reply("0x0");
    if (request.method === "alchemy_getTokenBalances") {
      return reply({
        tokenBalances: url.includes("base-mainnet")
          ? [
              { contractAddress: usdc, tokenBalance: "0x12a05f200" },
              { contractAddress: weth, tokenBalance: "0xde0b6b3a7640000" },
            ]
          : [],
      });
    }
    if (request.method === "alchemy_getTokenMetadata") {
      if (request.params[0] === usdc) {
        return new Response("Too Many Requests", { status: 429 });
      }
      return reply({ symbol: "WETH", name: "Wrapped Ether", decimals: 18 });
    }
    return new Response("unexpected", { status: 400 });
  });
  try {
    const chains = await fetchResolvedEvmBalances(
      "0x1111111111111111111111111111111111111111",
      {
        alchemyKey: "test-key",
        ankrKey: null,
        cloudManagedAccess: false,
        bscRpcUrls: [],
        ethereumRpcUrls: [],
        baseRpcUrls: [],
        avaxRpcUrls: [],
        nodeRealBscRpcUrl: null,
        quickNodeBscRpcUrl: null,
        bscRpcUrl: null,
        ethereumRpcUrl: null,
        baseRpcUrl: null,
        avaxRpcUrl: null,
      },
    );
    const base = chains.find((chain) => chain.chainId === 8453);
    expect(base?.error).toBeTruthy();
    expect(base?.tokens).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
  }
});
