/**
 * With a Helius key, Solana balances come from DAS getAssetsByOwner, whose
 * pages mix NFTs and fungible tokens. A fungible token on a later page must
 * still be listed. The Helius endpoint is replaced at fetch; price lookups to
 * other hosts get an empty answer.
 */
import { afterEach, expect, it, vi } from "vitest";
import { fetchSolanaBalances } from "../src/api/wallet.ts";

const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

afterEach(() => vi.unstubAllGlobals());

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

it("lists a fungible token that is on the second asset page", async () => {
  const pages: number[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith("https://mainnet.helius-rpc.com/")) {
        return json({ pairs: [] });
      }
      const request = JSON.parse(String(init?.body));
      if (request.method === "getBalance") {
        return json({ jsonrpc: "2.0", id: request.id, result: { value: 0 } });
      }
      const page = request.params.page as number;
      const limit = request.params.limit as number;
      pages.push(page);
      // Page 1 is full of NFTs; USDC is on page 2.
      const items =
        page === 1
          ? Array.from({ length: limit }, (_, i) => ({
              id: `nft-${i}`,
              interface: "V1_NFT",
            }))
          : [
              {
                id: USDC,
                interface: "FungibleToken",
                token_info: {
                  decimals: 6,
                  balance: 25_000_000,
                  symbol: "USDC",
                },
              },
            ];
      return json({ jsonrpc: "2.0", id: request.id, result: { items } });
    },
  );

  const result = await fetchSolanaBalances(OWNER, "test-key");

  expect(pages).toEqual([1, 2]);
  expect(result.tokens.map((token) => token.mint)).toEqual([USDC]);
});
