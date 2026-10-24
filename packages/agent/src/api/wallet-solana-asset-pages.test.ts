/**
 * Helius getAssetsByOwner pages include every NFT and compressed NFT, so a
 * wallet with many of them has its fungible tokens on a later page. Runs the
 * real fetchSolanaBalances; only the HTTP boundary is replaced by a server
 * double that pages the way Helius DAS does.
 */
import { afterEach, expect, it, vi } from "vitest";
import { fetchSolanaBalances } from "./wallet.ts";

const OWNER = "Owner11111111111111111111111111111111111111";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("finds a fungible token that sits after 1000 NFTs", async () => {
  const assets = [
    ...Array.from({ length: 1000 }, (_, index) => ({
      id: `nft-${index}`,
      interface: "V1_NFT",
    })),
    {
      id: "UsdcMint1111111111111111111111111111111111",
      interface: "FungibleToken",
      token_info: { symbol: "USDC", decimals: 6, balance: 25_000_000 },
      content: { metadata: { name: "USD Coin" } },
    },
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      if (!String(input).includes("helius-rpc.com")) {
        return Response.json({ pairs: [] });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        method: string;
        params: { page?: number; limit?: number };
      };
      if (body.method === "getBalance") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { value: 0 } });
      }
      const page = body.params.page ?? 1;
      const limit = body.params.limit ?? 1000;
      const items = assets.slice((page - 1) * limit, page * limit);
      return Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: { total: items.length, limit, page, items },
      });
    }),
  );

  const balances = await fetchSolanaBalances(OWNER, "test-key");

  expect(balances.tokens.map((token) => token.symbol)).toEqual(["USDC"]);
  expect(balances.tokens[0]?.balance).toBe("25");
});
