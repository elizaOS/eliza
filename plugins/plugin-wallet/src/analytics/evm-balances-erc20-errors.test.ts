/**
 * A JSON-RPC error envelope on `eth_call` is provider throttling / a bad key,
 * never "this wallet holds none of the tracked tokens".
 */
import { once } from "node:events";
import http from "node:http";
import { expect, it } from "vitest";
import type { EvmProviderKeyset } from "../read.ts";
import { fetchResolvedEvmBalances } from "../read.ts";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const TOKEN = "0x2222222222222222222222222222222222222222";

const keyset = (rpc: string): EvmProviderKeyset => ({
  alchemyKey: null,
  ankrKey: null,
  cloudManagedAccess: false,
  bscRpcUrls: [],
  ethereumRpcUrls: [rpc],
  baseRpcUrls: [],
  avaxRpcUrls: [],
  nodeRealBscRpcUrl: null,
  quickNodeBscRpcUrl: null,
  bscRpcUrl: null,
  ethereumRpcUrl: null,
  baseRpcUrl: null,
  avaxRpcUrl: null,
});

/** Serve JSON-RPC from 127.0.0.1 and resolve the chain for Ethereum mainnet. */
async function withRpcServer(
  reply: (request: {
    method: string;
    params: Array<{ data: string }>;
  }) => unknown,
  run: (rpc: string) => Promise<void>,
): Promise<void> {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        ...(reply(JSON.parse(body)) as object),
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

it("reports failed ERC-20 reads instead of an empty token list", async () => {
  let tokenCalls = 0;
  await withRpcServer(
    (request) => {
      if (request.method === "eth_getBalance")
        return { result: "0xde0b6b3a7640000" };
      tokenCalls += 1;
      // Providers answer throttling and auth failures with this envelope.
      return { error: { code: -32005, message: "rate limit exceeded" } };
    },
    async (rpc) => {
      const [chain] = await fetchResolvedEvmBalances(ADDRESS, keyset(rpc), [
        TOKEN,
      ]);
      expect(tokenCalls).toBeGreaterThan(0);
      expect(chain.chainId).toBe(1);
      // Before the fix this was a healthy chain: tokens=[] and error=null.
      expect(chain.tokens).toEqual([]);
      expect(chain.error).toMatch(/rate limit/);
    },
  );
});

it("keeps a genuine zero ERC-20 balance a healthy empty token list", async () => {
  await withRpcServer(
    (request) =>
      request.method === "eth_getBalance"
        ? { result: "0xde0b6b3a7640000" }
        : request.params[0].data.startsWith("0x70a08231")
          ? { result: "0x0" }
          : { result: "0x" },
    async (rpc) => {
      const [chain] = await fetchResolvedEvmBalances(ADDRESS, keyset(rpc), [
        TOKEN,
      ]);
      expect(chain.error).toBeNull();
      expect(chain.tokens).toEqual([]);
    },
  );
});
