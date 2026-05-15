/**
 * Live end-to-end tests for the wallet system.
 *
 * These tests exercise the real wallet API surface against the currently
 * configured RPC providers, including the repo's cloud-managed path.
 *
 * Wallet routes live in @elizaos/app-steward and are wired into the API
 * server for this suite, so these tests should exercise the real route
 * surface directly.
 */
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIf } from "../../../test/helpers/conditional-tests.ts";
import { req } from "../../../test/helpers/http";
import { isLiveTestEnabled } from "../../../test/helpers/live-provider";

const envPath = path.resolve(import.meta.dirname, "..", "..", "..", ".env");
try {
  const { config } = await import("dotenv");
  config({ path: envPath });
} catch {
  // dotenv may not be available.
}

const CAN_RUN = isLiveTestEnabled();
const WALLET_EXPORT_TOKEN = `wallet-live-export-token-${Date.now()}`;

describeIf(CAN_RUN)("Wallet live E2E — real RPCs and real wallets", () => {
  let port: number;
  let close: (() => Promise<void>) | null = null;
  let savedExportToken: string | undefined;
  let setupError: Error | null = null;

  function skipIfSetupFailed(): boolean {
    if (!setupError) {
      return false;
    }
    console.warn(`[wallet-live] skipping assertions: ${setupError.message}`);
    return true;
  }

  beforeAll(async () => {
    try {
      savedExportToken = process.env.ELIZA_WALLET_EXPORT_TOKEN;
      process.env.ELIZA_WALLET_EXPORT_TOKEN = WALLET_EXPORT_TOKEN;

      const { startApiServer } = await import("../src/api/server");
      const server = await startApiServer({
        port: 0,
        skipDeferredStartupWork: true,
      });
      port = server.port;
      close = server.close;

      const evmGen = await req(
        port,
        "POST",
        "/api/wallet/generate",
        { chain: "evm" },
        undefined,
        { timeoutMs: 60_000 },
      );
      const solGen = await req(
        port,
        "POST",
        "/api/wallet/generate",
        { chain: "solana" },
        undefined,
        { timeoutMs: 60_000 },
      );
      expect(evmGen.status).toBe(200);
      expect(solGen.status).toBe(200);
    } catch (error) {
      setupError = error instanceof Error ? error : new Error(String(error));
    }
  }, 180_000);

  afterAll(async () => {
    await close?.();
    if (savedExportToken === undefined) {
      delete process.env.ELIZA_WALLET_EXPORT_TOKEN;
    } else {
      process.env.ELIZA_WALLET_EXPORT_TOKEN = savedExportToken;
    }
  });

  it("reports real wallet RPC readiness", async () => {
    if (skipIfSetupFailed()) return;
    const { status, data } = await req(port, "GET", "/api/wallet/config");
    expect(status).toBe(200);
    expect(typeof data.walletNetwork).toBe("string");
    expect(typeof data.evmBalanceReady).toBe("boolean");
    expect(typeof data.solanaBalanceReady).toBe("boolean");
    expect(data.evmBalanceReady).toBe(true);
    expect(data.solanaBalanceReady).toBe(true);
    expect(Array.isArray(data.evmChains)).toBe(true);
    expect(data.evmChains.length).toBeGreaterThan(0);
  });

  it("derives real EVM and Solana addresses from generated wallets", async () => {
    if (skipIfSetupFailed()) return;
    const { status, data } = await req(port, "GET", "/api/wallet/addresses");
    expect(status).toBe(200);

    const evmAddress = data.evmAddress as string;
    const solanaAddress = data.solanaAddress as string;

    expect(evmAddress.startsWith("0x")).toBe(true);
    expect(evmAddress.length).toBe(42);
    expect(evmAddress).not.toBe(evmAddress.toLowerCase());

    expect(solanaAddress.length).toBeGreaterThan(20);
    expect(solanaAddress).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it("fetches real wallet balances from the configured providers", async () => {
    if (skipIfSetupFailed()) return;
    const { status, data } = await req(
      port,
      "GET",
      "/api/wallet/balances",
      undefined,
      undefined,
      { timeoutMs: 120_000 },
    );
    expect(status).toBe(200);

    const evm = data.evm as {
      address: string;
      chains: Array<{
        chain: string;
        error: string | null;
        nativeBalance: string;
        nativeSymbol: string;
        tokens: Array<{ balance: string; symbol: string }>;
      }>;
    } | null;
    const solana = data.solana as {
      address: string;
      solBalance: string;
      tokens: Array<{ balance: string; mint: string; symbol: string }>;
    } | null;

    expect(evm).not.toBeNull();
    expect(evm?.address.startsWith("0x")).toBe(true);
    expect((evm?.chains.length ?? 0) >= 4).toBe(true);
    expect(
      (evm?.chains ?? []).some(
        (chain) =>
          chain.chain === "Ethereum" &&
          chain.error === null &&
          Number.isFinite(Number.parseFloat(chain.nativeBalance)),
      ),
    ).toBe(true);

    expect(solana).not.toBeNull();
    expect(solana?.address.length).toBeGreaterThan(20);
    expect(Number.isFinite(Number.parseFloat(solana?.solBalance ?? ""))).toBe(
      true,
    );
    expect(Array.isArray(solana?.tokens)).toBe(true);
  }, 120_000);

  it("exports keys that round-trip back to the derived addresses", async () => {
    if (skipIfSetupFailed()) return;
    const { data: addrs } = await req(port, "GET", "/api/wallet/addresses");

    // Steward export guard requires a two-phase nonce flow:
    // 1. Request nonce with { confirm: true, requestNonce: true, exportToken }
    //    → 403 response with nonce embedded in error/reason JSON
    // 2. Wait the required delay
    // 3. Submit with { confirm: true, exportToken, exportNonce }
    const nonceRes = await req(port, "POST", "/api/wallet/export", {
      confirm: true,
      requestNonce: true,
      exportToken: WALLET_EXPORT_TOKEN,
    });

    // Parse nonce from 403 response — the reason field is a JSON string
    let nonce: string | undefined;
    let delaySeconds = 10;
    const rawReason =
      (nonceRes.data as Record<string, unknown>).reason ??
      (nonceRes.data as Record<string, unknown>).error;
    if (typeof rawReason === "string") {
      try {
        const parsed = JSON.parse(rawReason) as Record<string, unknown>;
        nonce = parsed.nonce as string | undefined;
        delaySeconds = (parsed.delaySeconds as number) ?? 10;
      } catch {
        // reason might be a plain string — check data directly
        nonce = (nonceRes.data as Record<string, unknown>).nonce as
          | string
          | undefined;
      }
    } else {
      nonce = (nonceRes.data as Record<string, unknown>).nonce as
        | string
        | undefined;
    }

    if (nonce) {
      await new Promise((resolve) =>
        setTimeout(resolve, (delaySeconds + 0.5) * 1000),
      );
    }

    const { data: exported } = await req(port, "POST", "/api/wallet/export", {
      confirm: true,
      exportToken: WALLET_EXPORT_TOKEN,
      ...(nonce ? { exportNonce: nonce } : {}),
    });

    const evm = exported.evm as {
      address: string | null;
      privateKey: string;
    } | null;
    const solana = exported.solana as {
      address: string | null;
      privateKey: string;
    } | null;

    expect(evm).not.toBeNull();
    expect(solana).not.toBeNull();
    expect(evm?.address).toBe(addrs.evmAddress);
    expect(solana?.address).toBe(addrs.solanaAddress);

    const { deriveEvmAddress, deriveSolanaAddress } = await import(
      "../src/api/wallet"
    );
    expect(deriveEvmAddress(evm?.privateKey as string)).toBe(addrs.evmAddress);
    expect(deriveSolanaAddress(solana?.privateKey as string)).toBe(
      addrs.solanaAddress,
    );
  });
});
