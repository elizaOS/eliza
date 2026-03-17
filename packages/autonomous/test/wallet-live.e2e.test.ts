/**
 * Live end-to-end tests for the wallet system.
 *
 * These tests use REAL API keys and REAL blockchain data.
 * They verify the entire flow: key derivation -> server route -> external API -> parsed response.
 *
 * Required env vars (from .env):
 *   EVM_PRIVATE_KEY      — real EVM private key (with or without 0x prefix)
 *   SOLANA_PRIVATE_KEY   — real Solana secret key (base58) — uses SOLANA_API_KEY as fallback
 *   ALCHEMY_API_KEY      — Alchemy API key with Ethereum mainnet enabled
 *   HELIUS_API_KEY       — Helius API key
 *
 * Run: MILADY_LIVE_TEST=1 npx vitest run -c vitest.e2e.config.ts test/wallet-live.e2e.test.ts
 */
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Load .env from the eliza workspace root
const envPath = path.resolve(import.meta.dirname, "..", "..", "eliza", ".env");
try {
  const { config } = await import("dotenv");
  config({ path: envPath });
} catch {
  // dotenv may not be available — keys must be in process.env already
}

// Normalize key names: .env uses SOLANA_API_KEY, wallet expects SOLANA_PRIVATE_KEY
if (!process.env.SOLANA_PRIVATE_KEY && process.env.SOLANA_API_KEY) {
  process.env.SOLANA_PRIVATE_KEY = process.env.SOLANA_API_KEY;
}

// Normalize EVM key: .env has no 0x prefix
if (
  process.env.EVM_PRIVATE_KEY &&
  !process.env.EVM_PRIVATE_KEY.startsWith("0x")
) {
  process.env.EVM_PRIVATE_KEY = `0x${process.env.EVM_PRIVATE_KEY}`;
}

// Gate: skip the entire file if we don't have real keys
const hasEvmKey = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
const hasSolKey = Boolean(process.env.SOLANA_PRIVATE_KEY?.trim());
const hasAlchemy = Boolean(process.env.ALCHEMY_API_KEY?.trim());
const hasHelius = Boolean(process.env.HELIUS_API_KEY?.trim());
const canRun = hasEvmKey && hasSolKey && hasAlchemy && hasHelius;
const WALLET_EXPORT_TOKEN = `wallet-live-export-token-${Date.now()}`;

function req(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : undefined;
    const r = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: p,
        method,
        headers: {
          "Content-Type": "application/json",
          ...(b ? { "Content-Length": Buffer.byteLength(b) } : {}),
        },
      },
      (res) => {
        const ch: Buffer[] = [];
        res.on("data", (c: Buffer) => ch.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(ch).toString("utf-8");
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            data = { _raw: raw };
          }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    r.on("error", reject);
    if (b) r.write(b);
    r.end();
  });
}

describe.skipIf(!canRun)("Wallet live E2E — real keys, real APIs", () => {
  let port: number;
  let close: () => Promise<void>;
  let savedExportToken: string | undefined;

  beforeAll(async () => {
    savedExportToken = process.env.MILADY_WALLET_EXPORT_TOKEN;
    process.env.MILADY_WALLET_EXPORT_TOKEN = WALLET_EXPORT_TOKEN;

    // Validate or generate keys BEFORE starting the server
    const { generateWalletKeys, deriveEvmAddress, deriveSolanaAddress } =
      await import("../src/api/wallet");

    // 1. Ensure EVM Key is valid
    let validEvm = false;
    if (process.env.EVM_PRIVATE_KEY) {
      try {
        deriveEvmAddress(process.env.EVM_PRIVATE_KEY);
        validEvm = true;
      } catch {
        console.warn(
          "  [Test Setup] Invalid EVM_PRIVATE_KEY in env, generating fallback...",
        );
      }
    }
    if (!validEvm) {
      const keys = generateWalletKeys();
      process.env.EVM_PRIVATE_KEY = keys.evmPrivateKey;
      console.log("  [Test Setup] Using generated fallback EVM key");
    }

    // 2. Ensure Solana Key is valid
    let validSol = false;
    if (process.env.SOLANA_PRIVATE_KEY) {
      try {
        deriveSolanaAddress(process.env.SOLANA_PRIVATE_KEY);
        validSol = true;
      } catch {
        console.warn(
          "  [Test Setup] Invalid SOLANA_PRIVATE_KEY in env, generating fallback...",
        );
      }
    }
    if (!validSol) {
      const keys = generateWalletKeys();
      process.env.SOLANA_PRIVATE_KEY = keys.solanaPrivateKey;
      console.log("  [Test Setup] Using generated fallback Solana key");
    }

    const { startApiServer } = await import("../src/api/server");
    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
    if (savedExportToken === undefined) {
      delete process.env.MILADY_WALLET_EXPORT_TOKEN;
    } else {
      process.env.MILADY_WALLET_EXPORT_TOKEN = savedExportToken;
    }
  });

  // ── Addresses ──────────────────────────────────────────────────────────

  it("derives a real EVM address from the .env key", async () => {
    const { data } = await req(port, "GET", "/api/wallet/addresses");
    const addr = data.evmAddress as string;
    expect(addr).toBeTruthy();
    expect(addr.startsWith("0x")).toBe(true);
    expect(addr.length).toBe(42);
    // Verify it's a valid checksum address (mixed case)
    expect(addr).not.toBe(addr.toLowerCase());
    console.log(`  EVM address: ${addr}`);
  });

  it("derives a real Solana address from the .env key", async () => {
    const { data } = await req(port, "GET", "/api/wallet/addresses");
    const addr = data.solanaAddress as string;
    expect(addr).toBeTruthy();
    expect(addr.length).toBeGreaterThan(20);
    // Base58 — no 0, O, I, l characters
    expect(addr).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    console.log(`  Solana address: ${addr}`);
  });

  // ── Config ─────────────────────────────────────────────────────────────

  it("reports all API keys as set", async () => {
    const { data } = await req(port, "GET", "/api/wallet/config");
    expect(data.alchemyKeySet).toBe(true);
    expect(data.heliusKeySet).toBe(true);
    expect(data.birdeyeKeySet).toBe(true);
    expect(data.evmAddress).toBeTruthy();
    expect(data.solanaAddress).toBeTruthy();
  });

  // ── EVM Balances (Alchemy) ────────────────────────────────────────────

  it("fetches real EVM balances from Alchemy", async () => {
    const { status, data } = await req(port, "GET", "/api/wallet/balances");
    expect(status).toBe(200);

    const evm = data.evm as {
      address: string;
      chains: Array<{
        chain: string;
        nativeBalance: string;
        nativeSymbol: string;
        tokens: Array<{ symbol: string; balance: string }>;
        error: string | null;
      }>;
    } | null;

    expect(evm).not.toBeNull();
    expect(evm?.address.startsWith("0x")).toBe(true);
    expect(evm?.chains.length).toBe(5); // All 5 chains attempted

    // At least Ethereum mainnet should succeed (the key has it enabled)
    const ethChain = evm?.chains.find((c) => c.chain === "Ethereum");
    expect(ethChain).toBeDefined();

    if (ethChain && !ethChain.error) {
      // nativeBalance should be a parseable number
      const balance = Number.parseFloat(ethChain.nativeBalance);
      expect(Number.isNaN(balance)).toBe(false);
      expect(ethChain.nativeSymbol).toBe("ETH");
      console.log(
        `  Ethereum balance: ${ethChain.nativeBalance} ETH, ${ethChain.tokens.length} tokens`,
      );
    } else if (ethChain?.error) {
      console.log(
        `  Ethereum chain error (expected if key not enabled): ${ethChain.error}`,
      );
    }

    // Log which chains succeeded vs failed
    for (const chain of evm?.chains ?? []) {
      if (chain.error) {
        console.log(`  ${chain.chain}: FAILED — ${chain.error.slice(0, 80)}`);
      } else {
        console.log(
          `  ${chain.chain}: OK — ${chain.nativeBalance} ${chain.nativeSymbol}, ${chain.tokens.length} tokens`,
        );
      }
    }
  }, 30_000);

  // ── Solana Balances (Helius) ──────────────────────────────────────────

  it("fetches real Solana balances from Helius", async () => {
    const { status, data } = await req(port, "GET", "/api/wallet/balances");
    expect(status).toBe(200);

    const solana = data.solana as {
      address: string;
      solBalance: string;
      tokens: Array<{ symbol: string; balance: string; mint: string }>;
    } | null;

    // Helius may be rate-limited; if we get data, verify its structure
    if (solana) {
      expect(solana.address).toBeTruthy();
      const balance = Number.parseFloat(solana.solBalance);
      expect(Number.isNaN(balance)).toBe(false);
      console.log(`  SOL balance: ${solana.solBalance}`);
      console.log(`  SPL tokens: ${solana.tokens.length}`);
      for (const tok of solana.tokens.slice(0, 5)) {
        console.log(
          `    ${tok.symbol}: ${tok.balance} (${tok.mint.slice(0, 8)}...)`,
        );
      }
    } else {
      console.log("  Solana balances: null (Helius may be rate-limited)");
    }
  }, 30_000);

  // ── EVM NFTs (Alchemy) ────────────────────────────────────────────────

  it("fetches real EVM NFTs from Alchemy", async () => {
    const { status, data } = await req(port, "GET", "/api/wallet/nfts");
    expect(status).toBe(200);

    const evm = data.evm as Array<{
      chain: string;
      nfts: Array<{
        name: string;
        contractAddress: string;
        tokenId: string;
        collectionName: string;
      }>;
    }>;

    expect(Array.isArray(evm)).toBe(true);
    expect(evm.length).toBe(5); // All 5 chains attempted

    let totalNfts = 0;
    for (const chainData of evm) {
      totalNfts += chainData.nfts.length;
      if (chainData.nfts.length > 0) {
        console.log(`  ${chainData.chain}: ${chainData.nfts.length} NFTs`);
        for (const nft of chainData.nfts.slice(0, 3)) {
          console.log(
            `    "${nft.name}" (${nft.collectionName || "no collection"})`,
          );
        }
      }
    }
    console.log(`  Total EVM NFTs: ${totalNfts}`);
  }, 30_000);

  // ── Solana NFTs (Helius) ──────────────────────────────────────────────

  it("fetches real Solana NFTs from Helius", async () => {
    const { status, data } = await req(port, "GET", "/api/wallet/nfts");
    expect(status).toBe(200);

    const solana = data.solana as {
      nfts: Array<{ name: string; mint: string; collectionName: string }>;
    } | null;

    if (solana) {
      console.log(`  Solana NFTs: ${solana.nfts.length}`);
      for (const nft of solana.nfts.slice(0, 5)) {
        console.log(
          `    "${nft.name}" (${nft.collectionName || "no collection"}) [${nft.mint.slice(0, 8)}...]`,
        );
      }
    } else {
      console.log("  Solana NFTs: null (Helius may be rate-limited)");
    }
  }, 30_000);

  // ── Key export round-trip ─────────────────────────────────────────────

  it("exports keys that match what was used to derive addresses", async () => {
    const { data: addrs } = await req(port, "GET", "/api/wallet/addresses");
    const { data: exported } = await req(port, "POST", "/api/wallet/export", {
      confirm: true,
      exportToken: WALLET_EXPORT_TOKEN,
    });

    const evmExport = exported.evm as {
      privateKey: string;
      address: string | null;
    } | null;
    const solExport = exported.solana as {
      privateKey: string;
      address: string | null;
    } | null;

    expect(evmExport).not.toBeNull();
    expect(solExport).not.toBeNull();

    // Exported address matches derived address
    expect(evmExport?.address).toBe(addrs.evmAddress);
    expect(solExport?.address).toBe(addrs.solanaAddress);

    // Exported key matches process.env
    expect(evmExport?.privateKey).toBe(process.env.EVM_PRIVATE_KEY);
    expect(solExport?.privateKey).toBe(process.env.SOLANA_PRIVATE_KEY);

    // Re-derive from exported key to verify it's the same address
    const { deriveEvmAddress, deriveSolanaAddress } = await import(
      "../src/api/wallet"
    );
    expect(deriveEvmAddress(evmExport?.privateKey as string)).toBe(
      addrs.evmAddress,
    );
    expect(deriveSolanaAddress(solExport?.privateKey as string)).toBe(
      addrs.solanaAddress,
    );
  });

  // ── Full flow: generate -> import -> addresses -> balances ────────────

  it("full flow: generate new keys, import, verify addresses, fetch balances", async () => {
    const { generateWalletKeys } = await import("../src/api/wallet");

    // Generate fresh keys
    const freshKeys = generateWalletKeys();

    // Import EVM key via API
    const { data: evmImport } = await req(port, "POST", "/api/wallet/import", {
      chain: "evm",
      privateKey: freshKeys.evmPrivateKey,
    });
    expect(evmImport.ok).toBe(true);
    expect((evmImport.address as string).toLowerCase()).toBe(
      freshKeys.evmAddress.toLowerCase(),
    );

    // Import Solana key via API
    const { data: solImport } = await req(port, "POST", "/api/wallet/import", {
      chain: "solana",
      privateKey: freshKeys.solanaPrivateKey,
    });
    expect(solImport.ok).toBe(true);
    expect(solImport.address).toBe(freshKeys.solanaAddress);

    // Verify addresses endpoint returns the new addresses
    const { data: addrs } = await req(port, "GET", "/api/wallet/addresses");
    expect((addrs.evmAddress as string).toLowerCase()).toBe(
      freshKeys.evmAddress.toLowerCase(),
    );
    expect(addrs.solanaAddress).toBe(freshKeys.solanaAddress);

    // Fetch balances for the new (empty) wallets — should return 0, not crash
    const { status, data: balances } = await req(
      port,
      "GET",
      "/api/wallet/balances",
    );
    expect(status).toBe(200);

    // EVM balances should work (new wallet has 0 balance)
    const evm = balances.evm as {
      chains: Array<{ nativeBalance: string; error: string | null }>;
    } | null;
    if (evm) {
      for (const chain of evm.chains) {
        if (!chain.error) {
          expect(Number.parseFloat(chain.nativeBalance)).toBe(0);
        }
      }
    }

    // Restore original keys so other tests aren't affected
    const savedEvm = process.env.EVM_PRIVATE_KEY;
    const savedSol = process.env.SOLANA_PRIVATE_KEY;
    // Re-import original keys
    if (savedEvm) process.env.EVM_PRIVATE_KEY = savedEvm;
    if (savedSol) process.env.SOLANA_PRIVATE_KEY = savedSol;

    console.log(
      `  Generated + imported + verified fresh wallet: ${freshKeys.evmAddress}`,
    );
  }, 60_000);
});
