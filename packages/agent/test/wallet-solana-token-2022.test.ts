/**
 * Solana balances without a Helius key are read over plain JSON-RPC. Token
 * accounts are owned by the classic SPL Token program or by Token-2022 (for
 * example PYUSD); both must be listed. A loopback JSON-RPC server answers per
 * program id; price lookups to other hosts get an empty answer.
 */
import { once } from "node:events";
import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { fetchSolanaNativeBalanceViaRpc } from "../src/api/wallet.ts";

const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PYUSD = "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo";

function tokenAccount(mint: string, uiAmountString: string, decimals: number) {
  return {
    account: {
      data: {
        parsed: {
          info: {
            mint,
            tokenAmount: { amount: "1", decimals, uiAmountString },
          },
        },
      },
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

it("lists Token-2022 token balances next to classic SPL tokens", async () => {
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    res.setHeader("Content-Type", "application/json");
    if (request.method === "getBalance") {
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: { value: 0 },
        }),
      );
      return;
    }
    const programId = request.params?.[1]?.programId;
    const value =
      programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        ? [tokenAccount(USDC, "25", 6)]
        : programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
          ? [tokenAccount(PYUSD, "500", 6)]
          : [];
    res.end(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { value } }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  const rpc = `http://127.0.0.1:${address.port}`;
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) =>
      String(input).startsWith(rpc)
        ? realFetch(input, init)
        : new Response(JSON.stringify({ pairs: [] }), {
            headers: { "Content-Type": "application/json" },
          }),
  );
  try {
    const result = await fetchSolanaNativeBalanceViaRpc(OWNER, [rpc]);
    expect(result.tokens.map((token) => token.mint).sort()).toEqual(
      [PYUSD, USDC].sort(),
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
