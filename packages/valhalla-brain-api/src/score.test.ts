import { describe, expect, it } from "bun:test";
import { scoreFromFacts, withinLimit } from "./score.ts";
import { handleRequest, hmacSha256Hex, sha256Hex, type MemoryStore } from "./worker.ts";

const MINT = "So11111111111111111111111111111111111111112";

describe("Valhalla Brain score", () => {
  it("lowers the score for mint authority and does not promise profit", () => {
    const result = scoreFromFacts({ mintAuthority: true, liquidityUsd: 1000 });
    expect(result.score).toBeLessThanOrEqual(20);
    expect(result.flags).toContain("mint authority");
    expect(result.disclaimer.toLowerCase()).not.toContain("guaranteed");
    expect(result.disclaimer).toContain("Not financial advice");
  });

  it("stops a free key after 100 calls", () => {
    expect(withinLimit("free", 99)).toBe(true);
    expect(withinLimit("free", 100)).toBe(false);
    expect(withinLimit("dev", 100)).toBe(true);
    expect(withinLimit("pro", 100)).toBe(true);
  });

  it("serves health, rejects a missing key, and scores a public mint", async () => {
    const store = await devStore();
    const health = await handleRequest(new Request("https://brain.local/v1/health"), store);
    expect(health.status).toBe(200);
    const denied = await handleRequest(new Request(`https://brain.local/v1/score/${MINT}`), emptyStore());
    expect(denied.status).toBe(401);
    const scored = await handleRequest(authed(`https://brain.local/v1/score/${MINT}`), store);
    expect(scored.status).toBe(200);
    expect(scored.headers.get("x-valhalla-disclaimer")).toContain("Not financial advice");
    const body = await scored.json();
    expect(body.score).toBeGreaterThanOrEqual(0);
    expect(body.score).toBeLessThanOrEqual(100);
    expect(body.upstream).toBe("not configured");
    expect(body.disclaimer).toContain("Not financial advice");
  });

  it("returns 429 on the 101st metered call for a free key", async () => {
    const store = await devStore("free");
    for (let i = 0; i < 100; i++) {
      const ok = await handleRequest(authed("https://brain.local/v1/trending"), store);
      expect(ok.status).toBe(200);
    }
    const blocked = await handleRequest(authed("https://brain.local/v1/trending"), store);
    expect(blocked.status).toBe(429);
  });

  it("scores a batch and a public wallet without a private key", async () => {
    const store = await devStore();
    const batch = await handleRequest(
      authed("https://brain.local/v1/score/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mints: [MINT, "nope"] }),
      }),
      store
    );
    const batchBody = await batch.json();
    expect(batchBody.results).toHaveLength(1);
    expect(JSON.stringify(batchBody).toLowerCase()).not.toContain("seed");
    const wallet = await handleRequest(
      authed(`https://brain.local/v1/wallet/${MINT}/summary`),
      store,
      {
        fetchImpl: async () =>
          new Response(JSON.stringify({ result: { value: 2_500_000_000 } }), { status: 200 }),
      }
    );
    const walletBody = await wallet.json();
    expect(walletBody.publicDataOnly).toBe(true);
    expect(walletBody.sol).toBe(2.5);
    expect(walletBody.tail).toBe("1112");
    expect(walletBody.note).toContain("No private key");
  });

  it("reads a Birdeye overview when the secret is set", async () => {
    const store = await devStore();
    const scored = await handleRequest(authed(`https://brain.local/v1/score/${MINT}`), store, {
      BIRDEYE_API_KEY: "test-bird",
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("token_security")) {
          return new Response(
            JSON.stringify({ data: { top10HolderPercent: 80, mintAuthority: true, freezeAuthority: false } }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ data: { liquidity: 1000, v24hChangePercent: 10 } }), { status: 200 });
      },
    });
    const body = await scored.json();
    expect(body.upstream).toBe("birdeye");
    expect(body.flags).toContain("mint authority");
    expect(body.score).toBeLessThanOrEqual(20);
  });

  it("updates a plan from a signed Lemon Squeezy event", async () => {
    const store = await devStore("free");
    const hash = await sha256Hex("dev");
    const raw = JSON.stringify({
      meta: { event_name: "subscription_created", custom_data: { api_key_hash: hash } },
      data: { attributes: { status: "active" } },
    });
    const secret = "lemon-test-secret";
    const bad = await handleRequest(
      new Request("https://brain.local/v1/billing/lemon", {
        method: "POST",
        headers: { "x-signature": "00" },
        body: raw,
      }),
      store,
      { LEMONSQUEEZY_SIGNING_SECRET: secret }
    );
    expect(bad.status).toBe(401);
    const signature = await hmacSha256Hex(secret, raw);
    const ok = await handleRequest(
      new Request("https://brain.local/v1/billing/lemon", {
        method: "POST",
        headers: { "x-signature": signature },
        body: raw,
      }),
      store,
      { LEMONSQUEEZY_SIGNING_SECRET: secret }
    );
    expect(ok.status).toBe(200);
    const usage = await handleRequest(authed("https://brain.local/v1/usage"), store);
    const usageBody = await usage.json();
    expect(usageBody.plan).toBe("pro");
    expect(usageBody.limit).toBe(100_000);
  });
});

function authed(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", "Bearer dev");
  return new Request(url, { ...init, headers });
}

async function devStore(plan: "free" | "dev" | "pro" = "dev"): Promise<MemoryStore> {
  return { keys: new Map([[await sha256Hex("dev"), plan]]), usage: new Map() };
}

function emptyStore(): MemoryStore {
  return { keys: new Map(), usage: new Map() };
}
