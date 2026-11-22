/**
 * Alchemy answers `getNFTsForOwner` with one page plus a `pageKey` while more
 * owned NFTs remain. A wallet read that returns the first page as the whole
 * collection silently drops the rest, so the list must follow every page.
 */
import { once } from "node:events";
import http from "node:http";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { EvmProviderKeyset } from "../read.ts";
import { fetchResolvedEvmNfts } from "../read.ts";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const TOTAL_NFTS = 53;
const FIRST_PAGE = 50;

const ownedNft = (index: number) => ({
  contract: { address: `0x${"2".repeat(40)}`, name: "Collection" },
  tokenId: String(index),
  name: `NFT ${index}`,
  tokenType: "ERC721",
});

const requests: Array<{ host: string; pageKey: string | null }> = [];

const nftServer = http.createServer((req, res) => {
  const host = String(req.headers["x-fixture-host"] ?? "");
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pageKey = url.searchParams.get("pageKey");
  requests.push({ host, pageKey });
  res.setHeader("Content-Type", "application/json");
  if (!host.startsWith("eth-mainnet")) {
    res.end(JSON.stringify({ ownedNfts: [], totalCount: 0 }));
    return;
  }
  if (pageKey === null) {
    res.end(
      JSON.stringify({
        ownedNfts: Array.from({ length: FIRST_PAGE }, (_, index) =>
          ownedNft(index),
        ),
        totalCount: TOTAL_NFTS,
        pageKey: "page-2",
      }),
    );
    return;
  }
  if (pageKey === "page-2") {
    res.end(
      JSON.stringify({
        ownedNfts: Array.from({ length: TOTAL_NFTS - FIRST_PAGE }, (_, index) =>
          ownedNft(FIRST_PAGE + index),
        ),
        totalCount: TOTAL_NFTS,
      }),
    );
    return;
  }
  res
    .writeHead(400)
    .end(JSON.stringify({ error: `unknown pageKey ${pageKey}` }));
});

const originalFetch = globalThis.fetch.bind(globalThis);
beforeAll(async () => {
  nftServer.listen(0, "127.0.0.1");
  await once(nftServer, "listening");
  const address = nftServer.address();
  if (!address || typeof address === "string") throw new Error("No NFT port");
  const fixture = `http://127.0.0.1:${address.port}`;
  // Keep the real HTTP transport: only the Alchemy host is re-routed to the
  // loopback fixture so a public provider cannot decide the test result.
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (!url.hostname.endsWith(".g.alchemy.com"))
      return originalFetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set("x-fixture-host", url.hostname);
    return originalFetch(`${fixture}${url.pathname}${url.search}`, {
      ...init,
      headers,
    });
  });
});
afterAll(async () => {
  vi.restoreAllMocks();
  nftServer.closeAllConnections();
  if (!nftServer.listening) return;
  await new Promise<void>((resolve, reject) =>
    nftServer.close((error) => (error ? reject(error) : resolve())),
  );
});

const keyset: EvmProviderKeyset = {
  alchemyKey: "test-alchemy-key",
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
};

it("reads every Alchemy NFT page instead of returning the first page", async () => {
  requests.length = 0;
  const chains = await fetchResolvedEvmNfts(ADDRESS, keyset);
  const ethereum = chains.find((entry) => entry.chain === "Ethereum");
  expect(ethereum?.nfts.map((nft) => nft.tokenId)).toEqual(
    Array.from({ length: TOTAL_NFTS }, (_, index) => String(index)),
  );
  expect(
    requests
      .filter((entry) => entry.host.startsWith("eth-mainnet"))
      .map((entry) => entry.pageKey),
  ).toEqual([null, "page-2"]);
});
