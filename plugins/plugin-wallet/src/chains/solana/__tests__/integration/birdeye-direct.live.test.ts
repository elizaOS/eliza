/**
 * Live integration tests for direct Birdeye and Helius API access.
 *
 * Uses raw fetch calls to verify Birdeye token prices, wallet data,
 * and Helius RPC endpoints work with the provided API keys.
 *
 * Requires: BIRDEYE_API_KEY and HELIUS_API_KEY in environment or ../.env.local
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

function loadLocalEnv(path: string): void {
  if (!existsSync(path)) {
    return;
  }

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed
      .slice(separatorIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, "");
    process.env[key] ??= value;
  }
}

loadLocalEnv(resolve(__dirname, "../.env.local"));

const BIRDEYE_KEY = process.env.BIRDEYE_API_KEY;
const HELIUS_KEY = process.env.HELIUS_API_KEY;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const BTC_MINT = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
const ETH_MINT = "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs";
const BIRDEYE_BASE = "https://public-api.birdeye.so";
const KNOWN_WALLET = "GK2zqSsXLA2rwVZk347RYhh6jJXRsAkGvVbR7MtsxKFQ";

function requireBirdeyeKey(): string {
  if (!BIRDEYE_KEY) {
    throw new Error("BIRDEYE_API_KEY is required for this test");
  }
  return BIRDEYE_KEY;
}

// ─── Birdeye Direct Tests ────────────────────────────────────────────────────

describe.skipIf(!BIRDEYE_KEY)("Birdeye direct API tests", () => {
  it("fetches SOL price from Birdeye", async () => {
    const response = await fetch(`${BIRDEYE_BASE}/defi/price?address=${SOL_MINT}`, {
      headers: {
        Accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": requireBirdeyeKey(),
      },
    });

    expect(response.ok).toBe(true);
    const data = (await response.json()) as {
      success: boolean;
      data: { value: number };
    };
    expect(data.success).toBe(true);
    expect(data.data.value).toBeGreaterThan(0);
    console.log(`SOL price: $${data.data.value.toFixed(2)}`);
  });

  it("fetches BTC (wrapped) price from Birdeye", async () => {
    const response = await fetch(`${BIRDEYE_BASE}/defi/price?address=${BTC_MINT}`, {
      headers: {
        Accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": requireBirdeyeKey(),
      },
    });

    expect(response.ok).toBe(true);
    const data = (await response.json()) as {
      success: boolean;
      data: { value: number };
    };
    expect(data.success).toBe(true);
    expect(data.data.value).toBeGreaterThan(0);
    console.log(`BTC price: $${data.data.value.toFixed(2)}`);
  });

  it("fetches ETH (wrapped) price from Birdeye", async () => {
    const response = await fetch(`${BIRDEYE_BASE}/defi/price?address=${ETH_MINT}`, {
      headers: {
        Accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": requireBirdeyeKey(),
      },
    });

    expect(response.ok).toBe(true);
    const data = (await response.json()) as {
      success: boolean;
      data: { value: number };
    };
    expect(data.success).toBe(true);
    expect(data.data.value).toBeGreaterThan(0);
    console.log(`ETH price: $${data.data.value.toFixed(2)}`);
  });

  it("fetches wallet token list from Birdeye", async () => {
    const response = await fetch(`${BIRDEYE_BASE}/v1/wallet/token_list?wallet=${KNOWN_WALLET}`, {
      headers: {
        Accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": requireBirdeyeKey(),
      },
    });

    expect(response.ok).toBe(true);
    const data = (await response.json()) as {
      success: boolean;
      data: { items: Array<{ symbol: string; uiAmount: number }> };
    };
    expect(data.success).toBe(true);
    expect(data.data.items).toBeDefined();
    console.log(`Wallet token count: ${data.data.items.length}`);
  });

  it("returns error for invalid API key", async () => {
    const response = await fetch(`${BIRDEYE_BASE}/defi/price?address=${SOL_MINT}`, {
      headers: {
        Accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": "invalid-key-12345",
      },
    });

    expect(response.ok).toBe(false);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

// ─── Helius RPC Direct Tests ─────────────────────────────────────────────────

/**
 * Check Helius availability before defining tests.
 * Free-tier keys exhaust quickly; we probe once and skip if rate-limited.
 */
async function checkHeliusAvailability(): Promise<boolean> {
  if (!HELIUS_KEY) return false;
  const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "getHealth" }),
  });
  const data = (await response.json()) as {
    result?: string;
    error?: { code: number; message: string };
  };
  if (data.error) {
    console.warn(`Helius unavailable: ${data.error.message} — skipping Helius tests`);
    return false;
  }
  return true;
}

// We run the availability check eagerly so we can skip the describe block
const heliusAvailablePromise = checkHeliusAvailability();

describe("Helius direct RPC tests", () => {
  let heliusAvailable = false;
  const heliusRpc = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

  beforeAll(async () => {
    heliusAvailable = await heliusAvailablePromise;
  });

  it("URL construction is correct", () => {
    expect(heliusRpc).toContain("helius-rpc.com");
    if (HELIUS_KEY) {
      expect(heliusRpc).toContain(HELIUS_KEY);
    }
  });

  it("fetches latest slot via Helius (or skips if rate-limited)", async () => {
    if (!heliusAvailable) {
      console.log("SKIPPED: Helius rate-limited or key not provided");
      return;
    }
    const response = await fetch(heliusRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot" }),
    });
    const data = (await response.json()) as {
      result?: number;
      error?: { message: string };
    };
    if (data.error) {
      console.log(`SKIPPED: ${data.error.message}`);
      return;
    }
    expect(data.result).toBeGreaterThan(0);
    console.log(`Solana slot: ${data.result}`);
  });

  it("fetches SOL balance via Helius (or skips if rate-limited)", async () => {
    if (!heliusAvailable) {
      console.log("SKIPPED: Helius rate-limited or key not provided");
      return;
    }
    const response = await fetch(heliusRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [KNOWN_WALLET],
      }),
    });
    const data = (await response.json()) as {
      result?: { value: number };
      error?: { message: string };
    };
    if (data.error) {
      console.log(`SKIPPED: ${data.error.message}`);
      return;
    }
    const balance = data.result?.value;
    if (typeof balance !== "number") {
      throw new Error("Expected Helius balance response to include a number");
    }
    expect(balance).toBeGreaterThanOrEqual(0);
    console.log(`SOL balance: ${balance / 1e9}`);
  });

  it("fetches block height via Helius (or skips if rate-limited)", async () => {
    if (!heliusAvailable) {
      console.log("SKIPPED: Helius rate-limited or key not provided");
      return;
    }
    const response = await fetch(heliusRpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBlockHeight" }),
    });
    const data = (await response.json()) as {
      result?: number;
      error?: { message: string };
    };
    if (data.error) {
      console.log(`SKIPPED: ${data.error.message}`);
      return;
    }
    expect(data.result).toBeGreaterThan(0);
    console.log(`Block height: ${data.result}`);
  });
});

// ─── Response Data Structure Verification ────────────────────────────────────

describe.skipIf(!BIRDEYE_KEY)("Birdeye response structure verification", () => {
  it("SOL price response has correct shape", async () => {
    const response = await fetch(`${BIRDEYE_BASE}/defi/price?address=${SOL_MINT}`, {
      headers: {
        Accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": requireBirdeyeKey(),
      },
    });

    const data = (await response.json()) as Record<string, unknown>;
    // Verify top-level structure
    expect(data).toHaveProperty("success", true);
    expect(data).toHaveProperty("data");
    const inner = data.data as Record<string, unknown>;
    expect(inner).toHaveProperty("value");
    expect(typeof inner.value).toBe("number");
    expect(inner.value as number).toBeGreaterThan(1); // SOL > $1
    expect(inner.value as number).toBeLessThan(10000); // SOL < $10,000
    // Verify updateUnixTime is present (timestamp)
    expect(inner).toHaveProperty("updateUnixTime");
    expect(typeof inner.updateUnixTime).toBe("number");
  });

  it("wallet token list has correct item shape", async () => {
    // Use a wallet known to have tokens — Solana Foundation
    const response = await fetch(
      `${BIRDEYE_BASE}/v1/wallet/token_list?wallet=GK2zqSsXLA2rwVZk347RYhh6jJXRsAkGvVbR7MtsxKFQ`,
      {
        headers: {
          Accept: "application/json",
          "x-chain": "solana",
          "X-API-KEY": requireBirdeyeKey(),
        },
      }
    );

    const data = (await response.json()) as Record<string, unknown>;
    expect(data).toHaveProperty("success", true);
    expect(data).toHaveProperty("data");
    const inner = data.data as {
      items: Array<Record<string, unknown>>;
      totalUsd?: number;
    };
    expect(inner).toHaveProperty("items");
    expect(Array.isArray(inner.items)).toBe(true);
  });

  it("non-existent token returns success:false or zero value", async () => {
    // Use a random (likely invalid) mint address
    const fakeMint = "1111111111111111111111111111111111111111111";
    const response = await fetch(`${BIRDEYE_BASE}/defi/price?address=${fakeMint}`, {
      headers: {
        Accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": requireBirdeyeKey(),
      },
    });

    const data = (await response.json()) as {
      success: boolean;
      data?: { value: number | null };
    };
    // Birdeye may return success:true with null value, or success:false
    if (data.success && data.data) {
      // Value should be 0 or null for non-existent token
      expect(data.data.value === null || data.data.value === 0).toBe(true);
    }
    // Either way, no crash
  });
});

// ─── Alchemy EVM RPC Data Verification (via live Birdeye test file) ──────────

describe.skipIf(!BIRDEYE_KEY)("Birdeye data sanity checks", () => {
  it("SOL price is between $1 and $10000", async () => {
    const response = await fetch(`${BIRDEYE_BASE}/defi/price?address=${SOL_MINT}`, {
      headers: {
        Accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": requireBirdeyeKey(),
      },
    });
    const data = (await response.json()) as { data: { value: number } };
    expect(data.data.value).toBeGreaterThan(1);
    expect(data.data.value).toBeLessThan(10000);
  });

  it("BTC price is between $10000 and $1000000", async () => {
    const response = await fetch(`${BIRDEYE_BASE}/defi/price?address=${BTC_MINT}`, {
      headers: {
        Accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": requireBirdeyeKey(),
      },
    });
    const data = (await response.json()) as { data: { value: number } };
    expect(data.data.value).toBeGreaterThan(10000);
    expect(data.data.value).toBeLessThan(1000000);
  });

  it("ETH price is between $100 and $100000", async () => {
    const response = await fetch(`${BIRDEYE_BASE}/defi/price?address=${ETH_MINT}`, {
      headers: {
        Accept: "application/json",
        "x-chain": "solana",
        "X-API-KEY": requireBirdeyeKey(),
      },
    });
    const data = (await response.json()) as { data: { value: number } };
    expect(data.data.value).toBeGreaterThan(100);
    expect(data.data.value).toBeLessThan(100000);
  });
});
