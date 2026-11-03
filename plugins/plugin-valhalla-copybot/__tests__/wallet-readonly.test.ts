import path from "node:path";
import { describe, expect, it } from "vitest";
import { fetchLiveSol } from "../src/live-balance.ts";
import { phantomBrowseLink, shortAddress, solflareBrowseLink } from "../src/wallet-client.ts";
import { findForbiddenWalletCalls } from "../scripts/forbid-wallet-sign.ts";

describe("read-only wallet connect", () => {
  it("shortens a public key and builds wallet app links", () => {
    expect(shortAddress("So11111111111111111111111111111111111111112")).toBe("…1112");
    expect(phantomBrowseLink("http://127.0.0.1:8787")).toContain("phantom.app/ul/browse/");
    expect(solflareBrowseLink("http://127.0.0.1:8787")).toContain("solflare.com/ul/v1/browse/");
  });

  it("reads a live balance from an RPC response", async () => {
    const hit = await fetchLiveSol(
      "So11111111111111111111111111111111111111112",
      "https://rpc.example",
      async () =>
        new Response(JSON.stringify({ result: { value: 2_500_000_000, context: { slot: 9 } } }), {
          status: 200,
        })
    );
    expect(hit.sol).toBe(2.5);
    expect(hit.slot).toBe(9);
  });

  it("fails when client code asks a wallet to sign or send a transaction", () => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    expect(findForbiddenWalletCalls(root)).toEqual([]);
  });
});
