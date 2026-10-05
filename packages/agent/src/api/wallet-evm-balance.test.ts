import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEvmBalances, fetchEvmNfts } from "./wallet-evm-balance.ts";

const ADDRESS = "0x0000000000000000000000000000000000000001";

function respondWith(body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("EVM provider JSON-RPC error envelopes", () => {
  it("reports an Alchemy HTTP 200 error envelope as a chain failure", async () => {
    respondWith({
      jsonrpc: "2.0",
      id: 1,
      error: { code: 429, message: "Your app has exceeded its capacity" },
    });

    const chains = await fetchEvmBalances(ADDRESS, "alchemy-test-key");

    expect(chains.length).toBeGreaterThan(0);
    for (const chain of chains) {
      expect(chain.error).toBe("Your app has exceeded its capacity");
    }
  });

  it("falls back to the RPC code when the envelope has no message", async () => {
    respondWith({ jsonrpc: "2.0", id: 1, error: { code: -32000 } });

    const chains = await fetchEvmBalances(ADDRESS, "alchemy-test-key");

    expect(chains[0]?.error).toBe("JSON-RPC error -32000");
  });

  it("surfaces an Alchemy NFT string error as a fetch failure", async () => {
    respondWith({ error: "Must be authenticated!" });
    const warn = vi.fn();
    const { logger } = await import("@elizaos/core");
    vi.spyOn(logger, "warn").mockImplementation(warn);

    await fetchEvmNfts(ADDRESS, "alchemy-test-key");

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Must be authenticated!"),
    );
  });
});
