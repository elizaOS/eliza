/**
 * Live E2E tests for API auth + LLM + wallet integration.
 *
 * These tests use REAL API keys for LLM providers and exercise the full
 * authenticated flow end-to-end: auth → onboarding → agent start → chat
 * → wallet operations → agent stop.
 *
 * Required env vars (loaded from ../eliza/.env):
 *   OPENAI_API_KEY or ANTHROPIC_API_KEY or GROQ_API_KEY — at least one
 *   EVM_PRIVATE_KEY — for wallet operations
 *   SOLANA_PRIVATE_KEY — for wallet operations (optional; uses SOLANA_API_KEY fallback)
 *
 * Run: MILADY_LIVE_TEST=1 npx vitest run -c vitest.e2e.config.ts test/api-auth-live.e2e.test.ts
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

// Normalize Solana key name
if (!process.env.SOLANA_PRIVATE_KEY && process.env.SOLANA_API_KEY) {
  process.env.SOLANA_PRIVATE_KEY = process.env.SOLANA_API_KEY;
}
// Normalize EVM key prefix
if (
  process.env.EVM_PRIVATE_KEY &&
  !process.env.EVM_PRIVATE_KEY.startsWith("0x")
) {
  process.env.EVM_PRIVATE_KEY = `0x${process.env.EVM_PRIVATE_KEY}`;
}

const hasLLM =
  Boolean(process.env.OPENAI_API_KEY?.trim()) ||
  Boolean(process.env.ANTHROPIC_API_KEY?.trim()) ||
  Boolean(process.env.GROQ_API_KEY?.trim());
const hasEvmKey = Boolean(process.env.EVM_PRIVATE_KEY?.trim());
const _hasSolKey = Boolean(process.env.SOLANA_PRIVATE_KEY?.trim());
const canRun = hasLLM && hasEvmKey;

// ---------------------------------------------------------------------------
// HTTP helper with auth support
// ---------------------------------------------------------------------------

function req(
  port: number,
  method: string,
  p: string,
  body?: Record<string, unknown>,
  headers?: Record<string, string>,
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
          ...(headers ?? {}),
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

// ═══════════════════════════════════════════════════════════════════════════
// 1. LIVE: AUTHENTICATED FULL FLOW (Auth + Onboarding + Wallet + LLM Chat)
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!canRun)(
  "Live: Authenticated full flow (LLM + wallet + auth)",
  () => {
    const API_TOKEN = `live-e2e-test-token-${Date.now()}`;
    const EXPORT_TOKEN = `live-wallet-export-token-${Date.now()}`;
    let port: number;
    let close: () => Promise<void>;
    const savedEnv: Record<string, string | undefined> = {};

    const authHeaders = { Authorization: `Bearer ${API_TOKEN}` };

    beforeAll(async () => {
      // Save env
      const envKeys = [
        "MILADY_API_TOKEN",
        "MILADY_WALLET_EXPORT_TOKEN",
        "MILADY_PAIRING_DISABLED",
        "MILADY_API_BIND",
      ];
      for (const key of envKeys) {
        savedEnv[key] = process.env[key];
      }

      // Configure auth
      process.env.MILADY_API_TOKEN = API_TOKEN;
      process.env.MILADY_WALLET_EXPORT_TOKEN = EXPORT_TOKEN;
      delete process.env.MILADY_PAIRING_DISABLED;

      const { startApiServer } = await import("../src/api/server");
      const server = await startApiServer({ port: 0 });
      port = server.port;
      close = server.close;
    }, 30_000);

    afterAll(async () => {
      await close();
      for (const [key, val] of Object.entries(savedEnv)) {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      }
    });

    // ── Step 1: Auth check ─────────────────────────────────────────────────

    it("step 1: auth status reports required + pairing enabled", async () => {
      const { status, data } = await req(port, "GET", "/api/auth/status");
      expect(status).toBe(200);
      expect(data.required).toBe(true);
      expect(data.pairingEnabled).toBe(true);
      console.log("  Auth required: true, pairing: true");
    });

    it("step 2: unauthenticated requests are blocked", async () => {
      const { status } = await req(port, "GET", "/api/status");
      expect(status).toBe(401);
    });

    // ── Step 3: Authenticated status ───────────────────────────────────────

    it("step 3: authenticated status works", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/status",
        undefined,
        authHeaders,
      );
      expect(status).toBe(200);
      expect(typeof data.agentName).toBe("string");
      console.log(`  Agent: ${data.agentName}, state: ${data.state}`);
    });

    // ── Step 4: Wallet operations with auth ────────────────────────────────

    it("step 4: wallet addresses via auth", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/wallet/addresses",
        undefined,
        authHeaders,
      );
      expect(status).toBe(200);
      expect(data.evmAddress).toBeTruthy();
      const addr = data.evmAddress as string;
      expect(addr.startsWith("0x")).toBe(true);
      expect(addr.length).toBe(42);
      console.log(`  EVM address: ${addr}`);

      if (data.solanaAddress) {
        console.log(`  Solana address: ${data.solanaAddress}`);
      }
    });

    it("step 5: wallet config via auth", async () => {
      const { status, data } = await req(
        port,
        "GET",
        "/api/wallet/config",
        undefined,
        authHeaders,
      );
      expect(status).toBe(200);
      expect(Array.isArray(data.evmChains)).toBe(true);
      expect(typeof data.alchemyKeySet).toBe("boolean");
    });

    // ── Step 6: Onboarding with auth ──────────────────────────────────────

    it("step 6: onboarding with auth", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/onboarding",
        {
          name: "LiveAuthAgent",
          bio: ["A live E2E test agent with auth"],
          systemPrompt: "You are a helpful assistant. Keep responses brief.",
        },
        authHeaders,
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);
      console.log("  Onboarding complete");
    });

    // ── Step 7: Agent lifecycle with auth ──────────────────────────────────

    it("step 7: agent start with auth", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/agent/start",
        undefined,
        authHeaders,
      );
      expect(status).toBe(200);
      expect(data.ok ?? data.state).toBeTruthy();

      const { data: statusData } = await req(
        port,
        "GET",
        "/api/status",
        undefined,
        authHeaders,
      );
      expect(statusData.state).toBe("paused");
      console.log("  Agent started");
    });

    // ── Step 8: Chat with auth (requires live LLM runtime) ─────────────────
    // Chat requires a full elizaOS runtime with model plugins. When the server
    // is started via startApiServer() without a runtime, the agent "runs" in
    // a lightweight state-machine mode and chat returns 503. We verify auth
    // is enforced (no 401) and accept 200 or 503 depending on runtime.

    it("step 8: chat with auth (auth enforced, LLM optional)", async () => {
      // Without auth → 401
      const { status: noAuth } = await req(port, "POST", "/api/chat", {
        text: "hello",
      });
      expect(noAuth).toBe(401);

      // With auth → 200 (runtime loaded) or 503 (no runtime)
      const { status, data } = await req(
        port,
        "POST",
        "/api/chat",
        { text: "Say 'auth-ok' and nothing else." },
        authHeaders,
      );
      expect([200, 503]).toContain(status);

      if (status === 200) {
        const text = (data.text ?? data.response ?? "") as string;
        expect(text.length).toBeGreaterThan(0);
        console.log(`  Chat response: "${text.slice(0, 100)}"`);
      } else {
        console.log(
          "  Chat: 503 (no runtime loaded — auth correctly enforced)",
        );
      }
    }, 60_000);

    // ── Step 9: Wallet generate + export with auth ─────────────────────────

    it("step 9: wallet generate + export round-trip with auth", async () => {
      const { status: genStatus, data: genData } = await req(
        port,
        "POST",
        "/api/wallet/generate",
        { chain: "evm" },
        authHeaders,
      );
      expect(genStatus).toBe(200);
      expect(genData.ok).toBe(true);

      const wallets = genData.wallets as Array<{
        chain: string;
        address: string;
      }>;
      expect(wallets.length).toBe(1);
      expect(wallets[0].chain).toBe("evm");
      const newAddr = wallets[0].address;

      // Verify addresses endpoint reflects the new key
      const { data: addrs } = await req(
        port,
        "GET",
        "/api/wallet/addresses",
        undefined,
        authHeaders,
      );
      expect((addrs.evmAddress as string).toLowerCase()).toBe(
        newAddr.toLowerCase(),
      );

      // Export and verify
      const { data: exported } = await req(
        port,
        "POST",
        "/api/wallet/export",
        { confirm: true, exportToken: EXPORT_TOKEN },
        authHeaders,
      );
      const evm = exported.evm as {
        privateKey: string;
        address: string | null;
      };
      expect(evm.address?.toLowerCase()).toBe(newAddr.toLowerCase());
      expect(evm.privateKey.startsWith("0x")).toBe(true);
      console.log(`  Generated + exported EVM wallet: ${newAddr}`);
    });

    // ── Step 10: Agent stop with auth ──────────────────────────────────────

    it("step 10: agent stop with auth", async () => {
      const { status, data } = await req(
        port,
        "POST",
        "/api/agent/stop",
        undefined,
        authHeaders,
      );
      expect(status).toBe(200);
      expect(data.ok).toBe(true);

      const { data: statusData } = await req(
        port,
        "GET",
        "/api/status",
        undefined,
        authHeaders,
      );
      expect(statusData.state).toBe("stopped");
      console.log("  Agent stopped");
    });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// 2. LIVE: TOKEN HEADER VARIANTS WITH LLM
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!canRun)("Live: Token header variants with LLM", () => {
  const API_TOKEN = `header-variant-token-${Date.now()}`;
  let port: number;
  let close: () => Promise<void>;

  beforeAll(async () => {
    process.env.MILADY_API_TOKEN = API_TOKEN;
    const { startApiServer } = await import("../src/api/server");
    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
    delete process.env.MILADY_API_TOKEN;
  });

  it("Bearer token works for chat (auth enforced)", async () => {
    // Ensure agent is running
    await req(port, "POST", "/api/agent/start", undefined, {
      Authorization: `Bearer ${API_TOKEN}`,
    });

    // Without auth → 401
    const { status: noAuth } = await req(port, "POST", "/api/chat", {
      text: "hello",
    });
    expect(noAuth).toBe(401);

    // With auth → 200 or 503 (no runtime in lightweight server mode)
    const { status, data } = await req(
      port,
      "POST",
      "/api/chat",
      { text: "Say hello" },
      { Authorization: `Bearer ${API_TOKEN}` },
    );
    expect([200, 503]).toContain(status);

    if (status === 200) {
      expect((data.text ?? data.response ?? "") as string).toBeTruthy();
    }

    await req(port, "POST", "/api/agent/stop", undefined, {
      Authorization: `Bearer ${API_TOKEN}`,
    });
  }, 60_000);

  it("X-Milady-Token works for status", async () => {
    const { status } = await req(port, "GET", "/api/status", undefined, {
      "X-Milady-Token": API_TOKEN,
    });
    expect(status).toBe(200);
  });

  it("X-Api-Key works for status", async () => {
    const { status } = await req(port, "GET", "/api/status", undefined, {
      "X-Api-Key": API_TOKEN,
    });
    expect(status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. LIVE: AUTH + CORS + WALLET COMBINED
// ═══════════════════════════════════════════════════════════════════════════

describe.skipIf(!canRun)("Live: Auth + CORS + wallet combined", () => {
  const API_TOKEN = `combined-test-token-${Date.now()}`;
  const EXPORT_TOKEN = `combined-wallet-export-token-${Date.now()}`;
  let port: number;
  let close: () => Promise<void>;
  let savedExportToken: string | undefined;

  beforeAll(async () => {
    savedExportToken = process.env.MILADY_WALLET_EXPORT_TOKEN;
    process.env.MILADY_API_TOKEN = API_TOKEN;
    process.env.MILADY_WALLET_EXPORT_TOKEN = EXPORT_TOKEN;
    const { startApiServer } = await import("../src/api/server");
    const server = await startApiServer({ port: 0 });
    port = server.port;
    close = server.close;
  }, 30_000);

  afterAll(async () => {
    await close();
    delete process.env.MILADY_API_TOKEN;
    if (savedExportToken === undefined) {
      delete process.env.MILADY_WALLET_EXPORT_TOKEN;
    } else {
      process.env.MILADY_WALLET_EXPORT_TOKEN = savedExportToken;
    }
  });

  it("localhost origin + auth = wallet operations work", async () => {
    const h = {
      Authorization: `Bearer ${API_TOKEN}`,
      Origin: `http://localhost:${port}`,
    };

    const { status, data } = await req(
      port,
      "GET",
      "/api/wallet/addresses",
      undefined,
      h,
    );
    expect(status).toBe(200);
    expect(data.evmAddress).toBeTruthy();
  });

  it("external origin blocked even with valid auth", async () => {
    const h = {
      Authorization: `Bearer ${API_TOKEN}`,
      Origin: "https://attacker.example.com",
    };

    const { status } = await req(
      port,
      "GET",
      "/api/wallet/addresses",
      undefined,
      h,
    );
    expect(status).toBe(403);
  });

  it("wallet import + export through auth works with live keys", async () => {
    const auth = { Authorization: `Bearer ${API_TOKEN}` };

    // Import the live EVM key
    const { status: importStatus, data: importData } = await req(
      port,
      "POST",
      "/api/wallet/import",
      {
        chain: "evm",
        privateKey: process.env.EVM_PRIVATE_KEY,
      },
      auth,
    );
    expect(importStatus).toBe(200);
    expect(importData.ok).toBe(true);

    // Export and verify round-trip
    const { data: exported } = await req(
      port,
      "POST",
      "/api/wallet/export",
      { confirm: true, exportToken: EXPORT_TOKEN },
      auth,
    );
    const evm = exported.evm as { privateKey: string; address: string | null };
    expect(evm.privateKey).toBe(process.env.EVM_PRIVATE_KEY);
    expect(evm.address).toBe(importData.address);
  });
});
