/**
 * E2E tests for the wallet API routes.
 *
 * Tests every /api/wallet/* endpoint against the REAL server (no mocks).
 * Some tests require API keys (ALCHEMY_API_KEY, HELIUS_API_KEY) and are
 * skipped when those keys are not present.
 */
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startApiServer } from "../src/api/server";

const WALLET_EXPORT_TEST_TOKEN = "wallet-export-e2e-step-up-token";

function withWalletExportToken(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (method !== "POST" || path !== "/api/wallet/export" || !body) return body;
  if (body.confirm !== true || typeof body.exportToken === "string")
    return body;
  return {
    ...body,
    exportToken:
      process.env.MILADY_WALLET_EXPORT_TOKEN ?? WALLET_EXPORT_TEST_TOKEN,
  };
}

// Load real API keys from the eliza workspace .env
const testDir = path.dirname(fileURLToPath(import.meta.url));
try {
  const { config } = await import("dotenv");
  config({ path: path.resolve(testDir, "..", "..", "eliza", ".env") });
} catch {
  /* dotenv may not be available */
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

function req(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  data: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const payload = withWalletExportToken(method, p, body);
    const b = payload ? JSON.stringify(payload) : undefined;
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
          resolve({ status: res.statusCode ?? 0, headers: res.headers, data });
        });
      },
    );
    r.on("error", reject);
    if (b) r.write(b);
    r.end();
  });
}

function walletConfigRequest(args: {
  selections?: {
    evm?: string;
    bsc?: string;
    solana?: string;
  };
  credentials?: Record<string, string>;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    selections: {
      evm: "eliza-cloud",
      bsc: "eliza-cloud",
      solana: "eliza-cloud",
      ...args.selections,
    },
    credentials: args.credentials ?? {},
    ...args.extra,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Wallet API E2E", () => {
  let port: number;
  let close: () => Promise<void>;

  // Save and restore env vars
  const savedEnv: Record<string, string | undefined> = {};
  const keysToSave = [
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
    "MILADY_WALLET_EXPORT_TOKEN",
    "ALCHEMY_API_KEY",
    "HELIUS_API_KEY",
    "BIRDEYE_API_KEY",
  ];

  beforeAll(async () => {
    // Save current env
    for (const key of keysToSave) {
      savedEnv[key] = process.env[key];
    }

    // Set test keys — use a known EVM key for deterministic address
    process.env.EVM_PRIVATE_KEY =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    process.env.SOLANA_PRIVATE_KEY =
      "4wBqpZM9xaSheZzJSMYGnGbUXDPSgWaC1LDUQ27gFdFtGm5qAshpcPMTgjLZ6Y7yDw3p6752kQhBEkZ1bPYoY8h";
    process.env.MILADY_WALLET_EXPORT_TOKEN = WALLET_EXPORT_TEST_TOKEN;

    // Start real server
    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
    // Restore env
    for (const key of keysToSave) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  // ── GET /api/wallet/addresses ──────────────────────────────────────────

  describe("GET /api/wallet/addresses", () => {
    it("returns EVM and Solana addresses", async () => {
      const { status, data } = await req(port, "GET", "/api/wallet/addresses");
      expect(status).toBe(200);
      expect(data.evmAddress).toBeDefined();
      expect(typeof data.evmAddress).toBe("string");
      expect((data.evmAddress as string).startsWith("0x")).toBe(true);
      expect((data.evmAddress as string).length).toBe(42);
      expect(data.solanaAddress).toBeDefined();
      expect(typeof data.solanaAddress).toBe("string");
    });

    it("derives correct EVM address from known private key", async () => {
      // The Hardhat test account #0 private key maps to:
      // 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
      const { data } = await req(port, "GET", "/api/wallet/addresses");
      expect((data.evmAddress as string).toLowerCase()).toBe(
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      );
    });
  });

  // ── GET /api/wallet/config ─────────────────────────────────────────────

  describe("GET /api/wallet/config", () => {
    it("returns config status with key indicators", async () => {
      const { status, data } = await req(port, "GET", "/api/wallet/config");
      expect(status).toBe(200);
      expect(typeof data.alchemyKeySet).toBe("boolean");
      expect(typeof data.heliusKeySet).toBe("boolean");
      expect(typeof data.birdeyeKeySet).toBe("boolean");
      expect(Array.isArray(data.evmChains)).toBe(true);
      expect(data.evmAddress).toBeDefined();
      expect(data.solanaAddress).toBeDefined();
    });

    it("reports correct chain list including BSC", async () => {
      const { data } = await req(port, "GET", "/api/wallet/config");
      const chains = data.evmChains as string[];
      expect(chains).toContain("Ethereum");
      expect(chains).toContain("Base");
      expect(chains).toContain("Arbitrum");
      expect(chains).toContain("Optimism");
      expect(chains).toContain("Polygon");
      expect(chains).toContain("BSC");
    });

    it("reports BSC RPC readiness flags", async () => {
      const { data } = await req(port, "GET", "/api/wallet/config");
      expect(typeof data.nodeRealBscRpcSet).toBe("boolean");
      expect(typeof data.quickNodeBscRpcSet).toBe("boolean");
      expect(typeof data.managedBscRpcReady).toBe("boolean");
    });
  });

  // ── PUT /api/wallet/config ─────────────────────────────────────────────

  describe("PUT /api/wallet/config", () => {
    // Save real API keys before the PUT tests overwrite them
    const realAlchemy = process.env.ALCHEMY_API_KEY;
    const realHelius = process.env.HELIUS_API_KEY;
    const realBirdeye = process.env.BIRDEYE_API_KEY;
    const realSolanaRpc = process.env.SOLANA_RPC_URL;
    const realNodeRealBsc = process.env.NODEREAL_BSC_RPC_URL;
    const realQuickNodeBsc = process.env.QUICKNODE_BSC_RPC_URL;
    const realBscRpc = process.env.BSC_RPC_URL;

    afterAll(() => {
      // Restore real keys so subsequent balance/NFT tests can use them
      if (realAlchemy) process.env.ALCHEMY_API_KEY = realAlchemy;
      else delete process.env.ALCHEMY_API_KEY;
      if (realHelius) process.env.HELIUS_API_KEY = realHelius;
      else delete process.env.HELIUS_API_KEY;
      if (realBirdeye) process.env.BIRDEYE_API_KEY = realBirdeye;
      else delete process.env.BIRDEYE_API_KEY;
      if (realSolanaRpc) process.env.SOLANA_RPC_URL = realSolanaRpc;
      else delete process.env.SOLANA_RPC_URL;
      if (realNodeRealBsc) process.env.NODEREAL_BSC_RPC_URL = realNodeRealBsc;
      else delete process.env.NODEREAL_BSC_RPC_URL;
      if (realQuickNodeBsc)
        process.env.QUICKNODE_BSC_RPC_URL = realQuickNodeBsc;
      else delete process.env.QUICKNODE_BSC_RPC_URL;
      if (realBscRpc) process.env.BSC_RPC_URL = realBscRpc;
      else delete process.env.BSC_RPC_URL;
    });

    it("saves API keys and returns ok", async () => {
      const { status, data } = await req(
        port,
        "PUT",
        "/api/wallet/config",
        walletConfigRequest({
          selections: {
            evm: "alchemy",
            solana: "helius-birdeye",
          },
          credentials: {
            ALCHEMY_API_KEY: "test-alchemy-key",
            HELIUS_API_KEY: "test-helius-key",
            BIRDEYE_API_KEY: "test-birdeye-key",
          },
        }),
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify keys were set
      expect(process.env.ALCHEMY_API_KEY).toBe("test-alchemy-key");
      expect(process.env.HELIUS_API_KEY).toBe("test-helius-key");
      expect(process.env.BIRDEYE_API_KEY).toBe("test-birdeye-key");
    });

    it("reflects saved keys in GET /api/wallet/config", async () => {
      // Set keys
      await req(
        port,
        "PUT",
        "/api/wallet/config",
        walletConfigRequest({
          selections: {
            evm: "alchemy",
          },
          credentials: {
            ALCHEMY_API_KEY: "test-alchemy-key-2",
          },
        }),
      );

      const { data } = await req(port, "GET", "/api/wallet/config");
      expect(data.alchemyKeySet).toBe(true);
      expect(data.selectedRpcProviders).toEqual({
        evm: "alchemy",
        bsc: "eliza-cloud",
        solana: "eliza-cloud",
      });
    });

    it("also sets SOLANA_RPC_URL when Helius key is provided", async () => {
      await req(
        port,
        "PUT",
        "/api/wallet/config",
        walletConfigRequest({
          selections: {
            solana: "helius-birdeye",
          },
          credentials: {
            HELIUS_API_KEY: "test-helius-rpc",
            BIRDEYE_API_KEY: "test-birdeye-rpc",
          },
        }),
      );

      expect(process.env.SOLANA_RPC_URL).toContain("test-helius-rpc");
      expect(process.env.SOLANA_RPC_URL).toContain("helius-rpc.com");
    });

    it("ignores unknown keys", async () => {
      const { status, data } = await req(
        port,
        "PUT",
        "/api/wallet/config",
        walletConfigRequest({
          selections: {
            evm: "alchemy",
          },
          credentials: {
            ALCHEMY_API_KEY: "valid-key",
          },
          extra: {
            UNKNOWN_KEY: "should-be-ignored",
          },
        }),
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(process.env.UNKNOWN_KEY).toBeUndefined();
    });

    it("saves the selected BSC provider and clears stale BSC keys", async () => {
      await req(
        port,
        "PUT",
        "/api/wallet/config",
        walletConfigRequest({
          selections: {
            bsc: "quicknode",
          },
          credentials: {
            QUICKNODE_BSC_RPC_URL: "https://bsc.quiknode.pro/old-key",
          },
        }),
      );

      const { status, data } = await req(
        port,
        "PUT",
        "/api/wallet/config",
        walletConfigRequest({
          selections: {
            bsc: "nodereal",
          },
          credentials: {
            NODEREAL_BSC_RPC_URL:
              "https://bsc-mainnet.nodereal.io/v1/test-key",
          },
        }),
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);

      // Verify only the selected provider remains configured
      expect(process.env.NODEREAL_BSC_RPC_URL).toBe(
        "https://bsc-mainnet.nodereal.io/v1/test-key",
      );
      expect(process.env.QUICKNODE_BSC_RPC_URL).toBeUndefined();
      expect(process.env.BSC_RPC_URL).toBeUndefined();

      // Verify reflected in GET /api/wallet/config
      const { data: config } = await req(port, "GET", "/api/wallet/config");
      expect(config.selectedRpcProviders).toEqual({
        evm: "eliza-cloud",
        bsc: "nodereal",
        solana: "eliza-cloud",
      });
      expect(config.nodeRealBscRpcSet).toBe(true);
      expect(config.quickNodeBscRpcSet).toBe(false);
      expect(config.managedBscRpcReady).toBe(true);
      expect(config.legacyCustomChains).toEqual([]);
    });
  });

  // ── POST /api/wallet/export ────────────────────────────────────────────

  describe("POST /api/wallet/export", () => {
    it("rejects export without confirm flag (empty body)", async () => {
      const { status } = await req(port, "POST", "/api/wallet/export", {});
      // Empty object has no `confirm` field, server returns 403
      expect(status).toBe(403);
    });

    it("rejects export with confirm: false", async () => {
      const { status } = await req(port, "POST", "/api/wallet/export", {
        confirm: false,
      });
      expect(status).toBe(403);
    });

    it("returns private keys and addresses with confirm: true", async () => {
      const { status, data } = await req(port, "POST", "/api/wallet/export", {
        confirm: true,
      });
      expect(status).toBe(200);

      const evm = data.evm as {
        privateKey: string;
        address: string | null;
      } | null;
      const solana = data.solana as {
        privateKey: string;
        address: string | null;
      } | null;

      expect(evm).not.toBeNull();
      expect(evm?.privateKey).toBeDefined();
      expect(evm?.privateKey.startsWith("0x")).toBe(true);
      expect(evm?.address).toBeDefined();

      expect(solana).not.toBeNull();
      expect(solana?.privateKey).toBeDefined();
      expect(solana?.address).toBeDefined();
    });

    it("returns the same key that was set in env", async () => {
      const { data } = await req(port, "POST", "/api/wallet/export", {
        confirm: true,
      });
      const evm = data.evm as { privateKey: string };
      expect(evm.privateKey).toBe(process.env.EVM_PRIVATE_KEY);
    });
  });

  // ── GET /api/wallet/balances (requires API keys) ───────────────────────

  describe("GET /api/wallet/balances", () => {
    it("returns balance structure (even if empty)", async () => {
      // This test works even without real API keys — server returns null for
      // chains that can't be fetched
      const { status, data } = await req(port, "GET", "/api/wallet/balances");
      expect(status).toBe(200);
      expect("evm" in data).toBe(true);
      expect("solana" in data).toBe(true);
    });

    it("fetches real EVM balances with Alchemy key", async () => {
      const { data } = await req(port, "GET", "/api/wallet/balances");
      const evm = data.evm as {
        address: string;
        chains: Array<{ chain: string; nativeBalance: string }>;
      } | null;
      if (evm) {
        expect(evm.address).toBeDefined();
        expect(evm.chains.length).toBeGreaterThan(0);
        expect(evm.chains[0].chain).toBeDefined();
        expect(evm.chains[0].nativeBalance).toBeDefined();
      }
    }, 60_000);

    it("fetches real Solana balances with Helius key", async () => {
      const { data } = await req(port, "GET", "/api/wallet/balances");
      const solana = data.solana as {
        address: string;
        solBalance: string;
      } | null;
      if (solana) {
        expect(solana.address).toBeDefined();
        expect(solana.solBalance).toBeDefined();
      }
    }, 60_000);
  });

  // ── GET /api/wallet/nfts (requires API keys) ──────────────────────────

  describe("GET /api/wallet/nfts", () => {
    it("returns NFT structure (even if empty)", async () => {
      const { status, data } = await req(port, "GET", "/api/wallet/nfts");
      expect(status).toBe(200);
      expect(Array.isArray(data.evm)).toBe(true);
      expect("solana" in data).toBe(true);
    });

    it("fetches real EVM NFTs with Alchemy key", async () => {
      const { data } = await req(port, "GET", "/api/wallet/nfts");
      const evm = data.evm as Array<{ chain: string; nfts: unknown[] }>;
      // API should return an array (possibly empty for test wallets)
      expect(Array.isArray(evm)).toBe(true);
      // Each chain entry should have the expected shape
      for (const chainData of evm) {
        expect(typeof chainData.chain).toBe("string");
        expect(Array.isArray(chainData.nfts)).toBe(true);
      }
    }, 60_000);
  });

  // ── POST /api/wallet/import ──────────────────────────────────────────

  describe("POST /api/wallet/import", () => {
    it("imports a valid EVM key", async () => {
      const { status, data } = await req(port, "POST", "/api/wallet/import", {
        chain: "evm",
        privateKey:
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.address).toBeDefined();
      expect((data.address as string).toLowerCase()).toBe(
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      );
    });

    it("imports a valid Solana key", async () => {
      const { status, data } = await req(port, "POST", "/api/wallet/import", {
        chain: "solana",
        privateKey: process.env.SOLANA_PRIVATE_KEY,
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.address).toBeDefined();
    });

    it("rejects missing privateKey", async () => {
      const { status } = await req(port, "POST", "/api/wallet/import", {
        chain: "evm",
      });
      expect(status).toBe(400);
    });

    it("rejects invalid chain value", async () => {
      const { status } = await req(port, "POST", "/api/wallet/import", {
        chain: "bitcoin",
        privateKey: "0xdead",
      });
      expect(status).toBe(400);
    });

    it("rejects an invalid EVM key format", async () => {
      const { status } = await req(port, "POST", "/api/wallet/import", {
        chain: "evm",
        privateKey: "not-hex-at-all",
      });
      expect(status).toBe(422);
    });

    it("auto-detects chain when not specified (EVM)", async () => {
      const { status, data } = await req(port, "POST", "/api/wallet/import", {
        privateKey:
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      });
      expect(status).toBe(200);
      expect(data.chain).toBe("evm");
    });
  });

  // ── POST /api/wallet/generate ────────────────────────────────────────

  describe("POST /api/wallet/generate", () => {
    it("generates both wallets by default", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/wallet/generate",
        {},
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      const wallets = data.wallets as Array<{ chain: string; address: string }>;
      expect(wallets.length).toBe(2);
      expect(wallets.find((w) => w.chain === "evm")).toBeDefined();
      expect(wallets.find((w) => w.chain === "solana")).toBeDefined();
    });

    it("generates only EVM when chain=evm", async () => {
      const { status, data } = await req(port, "POST", "/api/wallet/generate", {
        chain: "evm",
      });
      expect(status).toBe(200);
      const wallets = data.wallets as Array<{ chain: string; address: string }>;
      expect(wallets.length).toBe(1);
      expect(wallets[0].chain).toBe("evm");
      expect(wallets[0].address.startsWith("0x")).toBe(true);
    });

    it("generates only Solana when chain=solana", async () => {
      const { status, data } = await req(port, "POST", "/api/wallet/generate", {
        chain: "solana",
      });
      expect(status).toBe(200);
      const wallets = data.wallets as Array<{ chain: string; address: string }>;
      expect(wallets.length).toBe(1);
      expect(wallets[0].chain).toBe("solana");
    });

    it("rejects unsupported chain", async () => {
      const { status } = await req(port, "POST", "/api/wallet/generate", {
        chain: "bitcoin",
      });
      expect(status).toBe(400);
    });

    it("new keys are accessible via /api/wallet/addresses", async () => {
      await req(port, "POST", "/api/wallet/generate", { chain: "both" });
      const { data } = await req(port, "GET", "/api/wallet/addresses");
      expect(data.evmAddress).toBeDefined();
      expect(data.solanaAddress).toBeDefined();
    });
  });

  // ── Edge cases on existing routes ────────────────────────────────────

  describe("Edge cases", () => {
    it("GET /api/wallet/addresses with no keys returns nulls", async () => {
      const savedEvm = process.env.EVM_PRIVATE_KEY;
      const savedSol = process.env.SOLANA_PRIVATE_KEY;
      delete process.env.EVM_PRIVATE_KEY;
      delete process.env.SOLANA_PRIVATE_KEY;

      try {
        const { status, data } = await req(
          port,
          "GET",
          "/api/wallet/addresses",
        );
        expect(status).toBe(200);
        expect(data.evmAddress).toBeNull();
        expect(data.solanaAddress).toBeNull();
      } finally {
        if (savedEvm) process.env.EVM_PRIVATE_KEY = savedEvm;
        if (savedSol) process.env.SOLANA_PRIVATE_KEY = savedSol;
      }
    });

    it("POST /api/wallet/export with no keys returns nulls", async () => {
      const savedEvm = process.env.EVM_PRIVATE_KEY;
      const savedSol = process.env.SOLANA_PRIVATE_KEY;
      delete process.env.EVM_PRIVATE_KEY;
      delete process.env.SOLANA_PRIVATE_KEY;

      try {
        const { status, data } = await req(port, "POST", "/api/wallet/export", {
          confirm: true,
        });
        expect(status).toBe(200);
        expect(data.evm).toBeNull();
        expect(data.solana).toBeNull();
      } finally {
        if (savedEvm) process.env.EVM_PRIVATE_KEY = savedEvm;
        if (savedSol) process.env.SOLANA_PRIVATE_KEY = savedSol;
      }
    });

    it("PUT /api/wallet/config ignores blank string values", async () => {
      delete process.env.ALCHEMY_API_KEY;
      await req(port, "PUT", "/api/wallet/config", {
        ALCHEMY_API_KEY: "   ",
      });
      // Blank strings should NOT be stored
      expect(process.env.ALCHEMY_API_KEY).toBeUndefined();
    });

    it("GET /api/wallet/balances without API keys returns null for both", async () => {
      delete process.env.ALCHEMY_API_KEY;
      delete process.env.HELIUS_API_KEY;
      const { status, data } = await req(port, "GET", "/api/wallet/balances");
      expect(status).toBe(200);
      expect(data.evm).toBeNull();
      expect(data.solana).toBeNull();
    });

    it("concurrent requests to /api/wallet/addresses don't race", async () => {
      const results = await Promise.all([
        req(port, "GET", "/api/wallet/addresses"),
        req(port, "GET", "/api/wallet/addresses"),
        req(port, "GET", "/api/wallet/addresses"),
      ]);
      for (const { status, data } of results) {
        expect(status).toBe(200);
        // All should return the same addresses
        expect(data.evmAddress).toBe(results[0].data.evmAddress);
        expect(data.solanaAddress).toBe(results[0].data.solanaAddress);
      }
    });
  });

  // ── Onboarding key generation ──────────────────────────────────────────

  describe("Wallet key generation during onboarding", () => {
    it("generates keys when not present", async () => {
      const savedEvm = process.env.EVM_PRIVATE_KEY;
      const savedSol = process.env.SOLANA_PRIVATE_KEY;
      delete process.env.EVM_PRIVATE_KEY;
      delete process.env.SOLANA_PRIVATE_KEY;

      const freshServer = await startApiServer({ port: 0 });

      try {
        await req(freshServer.port, "POST", "/api/onboarding", {
          name: "TestAgent",
          bio: ["A test agent"],
          systemPrompt: "You are a test agent.",
        });

        expect(process.env.EVM_PRIVATE_KEY).toBeDefined();
        expect(process.env.SOLANA_PRIVATE_KEY).toBeDefined();

        const { data } = await req(
          freshServer.port,
          "GET",
          "/api/wallet/addresses",
        );
        expect(data.evmAddress).toBeDefined();
        expect(data.solanaAddress).toBeDefined();
      } finally {
        await freshServer.close();
        if (savedEvm) process.env.EVM_PRIVATE_KEY = savedEvm;
        else delete process.env.EVM_PRIVATE_KEY;
        if (savedSol) process.env.SOLANA_PRIVATE_KEY = savedSol;
        else delete process.env.SOLANA_PRIVATE_KEY;
      }
    }, 30_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Key Management E2E
// ═══════════════════════════════════════════════════════════════════════════

describe("Key Management E2E", () => {
  let port: number;
  let close: () => Promise<void>;

  const savedEnv: Record<string, string | undefined> = {};
  const keysToSave = [
    "EVM_PRIVATE_KEY",
    "SOLANA_PRIVATE_KEY",
    "MILADY_WALLET_EXPORT_TOKEN",
    "ALCHEMY_API_KEY",
    "HELIUS_API_KEY",
    "BIRDEYE_API_KEY",
  ];

  beforeAll(async () => {
    for (const key of keysToSave) {
      savedEnv[key] = process.env[key];
    }
    process.env.EVM_PRIVATE_KEY =
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
    process.env.SOLANA_PRIVATE_KEY =
      "4wBqpZM9xaSheZzJSMYGnGbUXDPSgWaC1LDUQ27gFdFtGm5qAshpcPMTgjLZ6Y7yDw3p6752kQhBEkZ1bPYoY8h";
    process.env.MILADY_WALLET_EXPORT_TOKEN = WALLET_EXPORT_TEST_TOKEN;

    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
    for (const key of keysToSave) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  // ── Auto-detect chain (Solana) ─────────────────────────────────────────

  describe("Auto-detect chain for Solana keys", () => {
    it("auto-detects a base58 key as Solana when chain is not specified", async () => {
      const { generateWalletKeys } = await import("../src/api/wallet");
      const keys = generateWalletKeys();

      const { status, data } = await req(port, "POST", "/api/wallet/import", {
        privateKey: keys.solanaPrivateKey,
      });
      expect(status).toBe(200);
      expect(data.chain).toBe("solana");
      expect(data.ok).toBe(true);
      expect(data.address).toBe(keys.solanaAddress);
    });

    it("auto-detects a 64-char hex string (no 0x) as EVM", async () => {
      const rawHex =
        "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
      const { status, data } = await req(port, "POST", "/api/wallet/import", {
        privateKey: rawHex,
      });
      expect(status).toBe(200);
      expect(data.chain).toBe("evm");
      expect(data.ok).toBe(true);
      expect((data.address as string).toLowerCase()).toBe(
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      );
    });
  });

  // ── Cross-chain confusion ──────────────────────────────────────────────

  describe("Cross-chain key confusion rejection", () => {
    it("rejects a Solana base58 key when chain is explicitly 'evm'", async () => {
      const { generateWalletKeys } = await import("../src/api/wallet");
      const keys = generateWalletKeys();

      const { status } = await req(port, "POST", "/api/wallet/import", {
        chain: "evm",
        privateKey: keys.solanaPrivateKey,
      });
      // Solana base58 key is not valid hex — should fail validation
      expect(status).toBe(422);
    });

    it("rejects an EVM hex key when chain is explicitly 'solana'", async () => {
      const { status } = await req(port, "POST", "/api/wallet/import", {
        chain: "solana",
        privateKey:
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      });
      // 0x-prefixed hex is not valid base58 — should fail validation
      expect(status).toBe(422);
    });
  });

  // ── Key rotation ───────────────────────────────────────────────────────

  describe("Key rotation via generate", () => {
    it("generates new keys that replace previous keys", async () => {
      // Capture current addresses
      const { data: addrsBefore } = await req(
        port,
        "GET",
        "/api/wallet/addresses",
      );
      expect(addrsBefore.evmAddress).toBeDefined();
      expect(addrsBefore.solanaAddress).toBeDefined();

      // Generate new keys
      const { status, data } = await req(
        port,
        "POST",
        "/api/wallet/generate",
        {},
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);

      // Addresses should change (astronomically unlikely to collide)
      const { data: addrsAfter } = await req(
        port,
        "GET",
        "/api/wallet/addresses",
      );
      expect(addrsAfter.evmAddress).not.toBe(addrsBefore.evmAddress);
      expect(addrsAfter.solanaAddress).not.toBe(addrsBefore.solanaAddress);

      // New addresses should still be valid format
      expect((addrsAfter.evmAddress as string).startsWith("0x")).toBe(true);
      expect((addrsAfter.evmAddress as string).length).toBe(42);
      expect((addrsAfter.solanaAddress as string).length).toBeGreaterThan(20);
    });

    it("second generate overwrites first generate", async () => {
      // Generate first set
      await req(port, "POST", "/api/wallet/generate", {});
      const { data: addrs1 } = await req(port, "GET", "/api/wallet/addresses");

      // Generate second set
      await req(port, "POST", "/api/wallet/generate", {});
      const { data: addrs2 } = await req(port, "GET", "/api/wallet/addresses");

      // Second set should be different from first
      expect(addrs2.evmAddress).not.toBe(addrs1.evmAddress);
      expect(addrs2.solanaAddress).not.toBe(addrs1.solanaAddress);
    });

    it("single-chain generate only rotates that chain", async () => {
      // Set known starting point
      await req(port, "POST", "/api/wallet/import", {
        chain: "evm",
        privateKey:
          "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
      });
      const { data: addrsBefore } = await req(
        port,
        "GET",
        "/api/wallet/addresses",
      );
      const solBefore = addrsBefore.solanaAddress;

      // Generate only EVM
      await req(port, "POST", "/api/wallet/generate", { chain: "evm" });
      const { data: addrsAfter } = await req(
        port,
        "GET",
        "/api/wallet/addresses",
      );

      // EVM should change, Solana should stay
      expect(addrsAfter.evmAddress).not.toBe(addrsBefore.evmAddress);
      expect(addrsAfter.solanaAddress).toBe(solBefore);
    });
  });

  // ── Import-Export round-trip ───────────────────────────────────────────

  describe("Import-Export round-trip", () => {
    it("exported EVM key matches what was imported", async () => {
      const importKey =
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
      await req(port, "POST", "/api/wallet/import", {
        chain: "evm",
        privateKey: importKey,
      });

      const { data } = await req(port, "POST", "/api/wallet/export", {
        confirm: true,
      });
      const evm = data.evm as { privateKey: string; address: string | null };
      expect(evm.privateKey).toBe(importKey);
      expect(evm.address?.toLowerCase()).toBe(
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      );
    });

    it("exported Solana key matches what was imported", async () => {
      const { generateWalletKeys } = await import("../src/api/wallet");
      const keys = generateWalletKeys();

      await req(port, "POST", "/api/wallet/import", {
        chain: "solana",
        privateKey: keys.solanaPrivateKey,
      });

      const { data } = await req(port, "POST", "/api/wallet/export", {
        confirm: true,
      });
      const solana = data.solana as {
        privateKey: string;
        address: string | null;
      };
      expect(solana.privateKey).toBe(keys.solanaPrivateKey);
      expect(solana.address).toBe(keys.solanaAddress);
    });

    it("generate -> export -> re-derive produces same addresses", async () => {
      const { deriveEvmAddress, deriveSolanaAddress } = await import(
        "../src/api/wallet"
      );

      await req(port, "POST", "/api/wallet/generate", {});
      const { data: addrs } = await req(port, "GET", "/api/wallet/addresses");
      const { data: exported } = await req(port, "POST", "/api/wallet/export", {
        confirm: true,
      });

      const evm = exported.evm as {
        privateKey: string;
        address: string | null;
      };
      const solana = exported.solana as {
        privateKey: string;
        address: string | null;
      };

      // Re-derive from exported private keys
      expect(deriveEvmAddress(evm.privateKey)).toBe(addrs.evmAddress);
      expect(deriveSolanaAddress(solana.privateKey)).toBe(addrs.solanaAddress);
    });
  });

  // ── Key format normalization end-to-end ────────────────────────────────

  describe("Key format normalization", () => {
    it("EVM key without 0x prefix is normalized on import", async () => {
      const rawHex =
        "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
      await req(port, "POST", "/api/wallet/import", {
        chain: "evm",
        privateKey: rawHex,
      });

      // Export should return the key WITH 0x prefix
      const { data } = await req(port, "POST", "/api/wallet/export", {
        confirm: true,
      });
      const evm = data.evm as { privateKey: string };
      expect(evm.privateKey.startsWith("0x")).toBe(true);
      expect(evm.privateKey).toBe(`0x${rawHex}`);
    });

    it("EVM key with leading/trailing whitespace is trimmed", async () => {
      const { status, data } = await req(port, "POST", "/api/wallet/import", {
        chain: "evm",
        privateKey:
          "  0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80  ",
      });
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      expect((data.address as string).toLowerCase()).toBe(
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
      );
    });
  });

  // ── Private key leak prevention ────────────────────────────────────────

  describe("Private key leak prevention", () => {
    it("GET /api/wallet/addresses does not expose private keys", async () => {
      const { data } = await req(port, "GET", "/api/wallet/addresses");
      const json = JSON.stringify(data);

      // Should NOT contain any private key material
      expect(json).not.toContain("PrivateKey");
      expect(json).not.toContain("privateKey");
      expect(json).not.toContain("private_key");
      expect(json).not.toContain("secret");
      // Should only have evmAddress and solanaAddress
      expect(Object.keys(data).sort()).toEqual(
        ["evmAddress", "solanaAddress"].sort(),
      );
    });

    it("GET /api/wallet/config does not expose private keys", async () => {
      const { data } = await req(port, "GET", "/api/wallet/config");
      const json = JSON.stringify(data);

      expect(json).not.toContain("PrivateKey");
      expect(json).not.toContain("privateKey");
      expect(json).not.toContain("private_key");
      // Should have boolean indicators, not actual key values
      expect(typeof data.alchemyKeySet).toBe("boolean");
      expect(typeof data.heliusKeySet).toBe("boolean");
    });

    it("POST /api/wallet/export without confirm does not leak keys", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/wallet/export",
        {},
      );
      expect(status).toBe(403);
      const json = JSON.stringify(data);
      expect(json).not.toContain(
        process.env.EVM_PRIVATE_KEY?.slice(4) ?? "NOKEY",
      );
    });

    it("GET /api/wallet/balances does not expose private keys", async () => {
      const { data } = await req(port, "GET", "/api/wallet/balances");
      const json = JSON.stringify(data);

      expect(json).not.toContain("PrivateKey");
      expect(json).not.toContain("privateKey");
      expect(json).not.toContain("private_key");
    });
  });

  // ── Error recovery ─────────────────────────────────────────────────────

  describe("Error recovery — invalid import preserves existing key", () => {
    it("failed EVM import does not corrupt existing EVM key", async () => {
      // Import a known good key
      const goodKey =
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
      await req(port, "POST", "/api/wallet/import", {
        chain: "evm",
        privateKey: goodKey,
      });

      const { data: addrsBefore } = await req(
        port,
        "GET",
        "/api/wallet/addresses",
      );
      expect(addrsBefore.evmAddress).toBeTruthy();

      // Attempt to import an invalid key
      const { status } = await req(port, "POST", "/api/wallet/import", {
        chain: "evm",
        privateKey: "not-a-valid-key-at-all",
      });
      expect(status).toBe(422);

      // Original key should still be intact
      const { data: addrsAfter } = await req(
        port,
        "GET",
        "/api/wallet/addresses",
      );
      expect(addrsAfter.evmAddress).toBe(addrsBefore.evmAddress);

      // Export should still return the original key
      const { data: exported } = await req(port, "POST", "/api/wallet/export", {
        confirm: true,
      });
      expect((exported.evm as { privateKey: string }).privateKey).toBe(goodKey);
    });

    it("failed Solana import does not corrupt existing Solana key", async () => {
      const { generateWalletKeys } = await import("../src/api/wallet");
      const keys = generateWalletKeys();

      // Import a good Solana key
      await req(port, "POST", "/api/wallet/import", {
        chain: "solana",
        privateKey: keys.solanaPrivateKey,
      });

      const { data: addrsBefore } = await req(
        port,
        "GET",
        "/api/wallet/addresses",
      );
      expect(addrsBefore.solanaAddress).toBe(keys.solanaAddress);

      // Attempt invalid Solana import (0x-prefixed is not base58)
      const { status } = await req(port, "POST", "/api/wallet/import", {
        chain: "solana",
        privateKey: "0xthis-is-not-base58-at-all",
      });
      expect(status).toBe(422);

      // Original key should still be intact
      const { data: addrsAfter } = await req(
        port,
        "GET",
        "/api/wallet/addresses",
      );
      expect(addrsAfter.solanaAddress).toBe(addrsBefore.solanaAddress);
    });

    it("server stays healthy after 10 consecutive invalid imports", async () => {
      const invalidKeys = [
        "not-a-key",
        "",
        "   ",
        "0xZZZZ",
        `0x${"f".repeat(63)}`, // 63 chars, one too short
        `0x${"f".repeat(65)}`, // 65 chars, one too long
        "000InvalidBase58!!!",
        `0x${"g".repeat(64)}`, // invalid hex char
        "null",
        "undefined",
      ];

      for (const key of invalidKeys) {
        const { status } = await req(port, "POST", "/api/wallet/import", {
          chain: "evm",
          privateKey: key,
        });
        // Should be 400 (missing/empty) or 422 (invalid format), never 500
        expect(status).toBeLessThan(500);
      }

      // Server should still be healthy and responsive
      const { status, data } = await req(port, "GET", "/api/wallet/addresses");
      expect(status).toBe(200);
      expect(typeof data.evmAddress).toBe("string");
    });
  });

  // ── Concurrent key operations ──────────────────────────────────────────

  describe("Concurrent key operations", () => {
    it("concurrent imports do not leave keys in inconsistent state", async () => {
      const { generateWalletKeys } = await import("../src/api/wallet");
      const keysets = Array.from({ length: 5 }, () => generateWalletKeys());

      // Fire 5 concurrent EVM imports — one should win
      const results = await Promise.all(
        keysets.map((keys) =>
          req(port, "POST", "/api/wallet/import", {
            chain: "evm",
            privateKey: keys.evmPrivateKey,
          }),
        ),
      );

      // All should succeed (200)
      for (const r of results) {
        expect(r.status).toBe(200);
      }

      // The resulting address should be one of the imported ones
      const { data } = await req(port, "GET", "/api/wallet/addresses");
      const possibleAddresses = keysets.map((k) => k.evmAddress.toLowerCase());
      expect(
        possibleAddresses.includes((data.evmAddress as string).toLowerCase()),
      ).toBe(true);

      // Export should return the key that matches the current address
      const { data: exported } = await req(port, "POST", "/api/wallet/export", {
        confirm: true,
      });
      const exportedEvm = exported.evm as {
        privateKey: string;
        address: string | null;
      };
      expect(exportedEvm.address?.toLowerCase()).toBe(
        (data.evmAddress as string).toLowerCase(),
      );
    });

    it("concurrent generate and read don't crash", async () => {
      // Fire generate + reads concurrently
      const ops = [
        req(port, "POST", "/api/wallet/generate", {}),
        req(port, "GET", "/api/wallet/addresses"),
        req(port, "GET", "/api/wallet/config"),
        req(port, "GET", "/api/wallet/addresses"),
        req(port, "POST", "/api/wallet/generate", {}),
        req(port, "GET", "/api/wallet/addresses"),
      ];

      const results = await Promise.all(ops);

      // No 500 errors
      for (const r of results) {
        expect(r.status).toBeLessThan(500);
      }

      // Final state should be consistent
      const { status, data } = await req(port, "GET", "/api/wallet/addresses");
      expect(status).toBe(200);
      expect((data.evmAddress as string).startsWith("0x")).toBe(true);
      expect((data.evmAddress as string).length).toBe(42);
    });
  });
});

// Wallet module unit tests (address derivation — kept for fast feedback)

describe("Wallet module — address derivation", () => {
  it("generates valid wallet keys", async () => {
    const { generateWalletKeys } = await import("../src/api/wallet");
    const keys = generateWalletKeys();

    // EVM
    expect(keys.evmPrivateKey.startsWith("0x")).toBe(true);
    expect(keys.evmPrivateKey.length).toBe(66); // 0x + 64 hex chars
    expect(keys.evmAddress.startsWith("0x")).toBe(true);
    expect(keys.evmAddress.length).toBe(42);

    // Solana
    expect(keys.solanaPrivateKey.length).toBeGreaterThan(0);
    expect(keys.solanaAddress.length).toBeGreaterThan(0);
  });

  it("derives deterministic EVM address", async () => {
    const { deriveEvmAddress } = await import("../src/api/wallet");

    // Hardhat test account #0
    const address = deriveEvmAddress(
      "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    );
    expect(address.toLowerCase()).toBe(
      "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
    );
  });

  it("derives deterministic Solana address", async () => {
    const { generateWalletKeys, deriveSolanaAddress } = await import(
      "../src/api/wallet"
    );

    // Generate and then re-derive — should be consistent
    const keys = generateWalletKeys();
    const rederived = deriveSolanaAddress(keys.solanaPrivateKey);
    expect(rederived).toBe(keys.solanaAddress);
  });

  it("generates different keys on each call", async () => {
    const { generateWalletKeys } = await import("../src/api/wallet");
    const keys1 = generateWalletKeys();
    const keys2 = generateWalletKeys();

    expect(keys1.evmPrivateKey).not.toBe(keys2.evmPrivateKey);
    expect(keys1.solanaPrivateKey).not.toBe(keys2.solanaPrivateKey);
    expect(keys1.evmAddress).not.toBe(keys2.evmAddress);
    expect(keys1.solanaAddress).not.toBe(keys2.solanaAddress);
  });
});
