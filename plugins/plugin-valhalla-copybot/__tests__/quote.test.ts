import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits.ts";
import { isMint, quoteBuy } from "../src/quote.ts";

const MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";

function fakeJupiter(payload: unknown, status = 200) {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

describe("read-only swap quote", () => {
  it("accepts a base58 mint and rejects everything else", () => {
    expect(isMint(MINT)).toBe(true);
    expect(isMint("not-a-mint")).toBe(false);
    expect(isMint("")).toBe(false);
    expect(isMint(null)).toBe(false);
    expect(isMint(42)).toBe(false);
  });

  it("quotes a SOL buy against the Jupiter quote host only", async () => {
    const { fetchImpl, seen } = fakeJupiter({
      inAmount: "100000000",
      outAmount: "2500000",
      priceImpactPct: "0.0012",
      routePlan: [{ swapInfo: { label: "Raydium" } }, { swapInfo: { label: "Orca" } }],
    });
    const quote = await quoteBuy({ mint: MINT, sol: 0.1 }, fetchImpl);
    expect(quote.outAmount).toBe("2500000");
    expect(quote.inAmount).toBe("100000000");
    expect(quote.route).toBe("Raydium -> Orca");
    expect(quote.jupiterUrl).toBe(`https://jup.ag/swap/SOL-${MINT}`);
    const url = new URL(seen[0]);
    expect(url.hostname).toBe("lite-api.jup.ag");
    expect(url.pathname).toBe("/swap/v1/quote");
    expect(url.searchParams.get("inputMint")).toBe(LIMITS.wsolMint);
    expect(url.searchParams.get("outputMint")).toBe(MINT);
    expect(url.searchParams.get("amount")).toBe("100000000");
    // The quote path must never touch the swap endpoint.
    expect(url.pathname).not.toContain("/swap/v1/swap");
  });

  it("refuses a bad amount before it calls out", async () => {
    const { fetchImpl, seen } = fakeJupiter({ outAmount: "1" });
    await expect(quoteBuy({ mint: MINT, sol: 0 }, fetchImpl)).rejects.toThrow(/above zero/i);
    await expect(quoteBuy({ mint: MINT, sol: -1 }, fetchImpl)).rejects.toThrow(/above zero/i);
    await expect(quoteBuy({ mint: MINT, sol: "abc" }, fetchImpl)).rejects.toThrow(/above zero/i);
    await expect(quoteBuy({ mint: MINT, sol: 5_000 }, fetchImpl)).rejects.toThrow(/desk limit/i);
    await expect(quoteBuy({ mint: "nope", sol: 0.1 }, fetchImpl)).rejects.toThrow(/token address/i);
    expect(seen).toEqual([]);
  });

  it("reports an upstream error and an empty route instead of a fake fill", async () => {
    const bad = fakeJupiter({}, 503);
    await expect(quoteBuy({ mint: MINT, sol: 0.1 }, bad.fetchImpl)).rejects.toThrow(/HTTP 503/);
    const empty = fakeJupiter({ outAmount: "0" });
    await expect(quoteBuy({ mint: MINT, sol: 0.1 }, empty.fetchImpl)).rejects.toThrow(/no route/i);
  });
});
