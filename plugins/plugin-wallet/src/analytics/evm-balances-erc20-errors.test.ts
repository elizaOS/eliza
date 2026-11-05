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

it("keeps a real balance when only the symbol call reverts", async () => {
  // `symbol()` is a label, not evidence about the balance. A token whose symbol
  // cannot be decoded (bytes32 symbols, a revert on a proxy) still holds a real
  // amount; that answer must not be replaced by a chain-level RPC fault.
  await withRpcServer(
    (request) => {
      if (request.method === "eth_getBalance")
        return { result: "0xde0b6b3a7640000" };
      const data = request.params[0].data;
      if (data.startsWith("0x70a08231"))
        return { result: "0x1bc16d674ec80000" };
      if (data.startsWith("0x313ce567")) return { result: "0x12" };
      return { error: { code: 3, message: "execution reverted" } };
    },
    async (rpc) => {
      const [chain] = await fetchResolvedEvmBalances(ADDRESS, keyset(rpc), [
        TOKEN,
      ]);
      // Before the fix the revert escaped Promise.all, failed the token read,
      // and turned the whole chain into "RPC unavailable".
      expect(chain.error).toBeNull();
      expect(chain.tokens).toHaveLength(1);
      expect(chain.tokens[0].symbol).toBe("TOKEN");
      expect(chain.tokens[0].balance).toBe("2");
    },
  );
});

it("keeps a zero balance healthy when only the token metadata reverts", async () => {
  // `symbol()` / `decimals()` are cosmetic: a token whose metadata call
  // reverts is still a token this wallet holds none of. Reading the balance
  // first means that answer survives, instead of the revert turning the whole
  // chain into a provider fault.
  const seen: string[] = [];
  await withRpcServer(
    (request) => {
      if (request.method === "eth_getBalance")
        return { result: "0xde0b6b3a7640000" };
      const data = request.params[0].data;
      seen.push(data.slice(0, 10));
      return data.startsWith("0x70a08231")
        ? { result: "0x0" }
        : { error: { code: 3, message: "execution reverted" } };
    },
    async (rpc) => {
      const [chain] = await fetchResolvedEvmBalances(ADDRESS, keyset(rpc), [
        TOKEN,
      ]);
      expect(chain.tokens).toEqual([]);
      expect(chain.error).toBeNull();
      // The metadata calls are skipped once the balance says zero.
      expect(seen).toEqual(["0x70a08231"]);
    },
  );
});
