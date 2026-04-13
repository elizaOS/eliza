/**
 * Live end-to-end tests for the wallet system.
 *
 * These tests exercise the real wallet API surface against the currently
 * configured RPC providers, including the repo's cloud-managed path.
 */
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  beforeAll(async () => {
    savedExportToken = process.env.ELIZA_WALLET_EXPORT_TOKEN;
    process.env.ELIZA_WALLET_EXPORT_TOKEN = WALLET_EXPORT_TOKEN;

    const { startApiServer } = await import("../src/api/server");
    const server = await startApiServer({
      port: 0,
      skipDeferredStartupWork: true,
    });
    port = server.port;
    close = server.close;

    await req(port, "POST", "/api/wallet/generate", { chain: "evm" });
    await req(port, "POST", "/api/wallet/generate", { chain: "solana" });
  }, 60_000);

  afterAll(async () => {
    await close?.();
    if (savedExportToken === undefined) {
      delete process.env.ELIZA_WALLET_EXPORT_TOKEN;
    } else {
      process.env.ELIZA_WALLET_EXPORT_TOKEN = savedExportToken;
    }
  });

  it("reports real wallet RPC readiness", async () => {
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
    const { data: addrs } = await req(port, "GET", "/api/wallet/addresses");
    const { data: exported } = await req(port, "POST", "/api/wallet/export", {
      confirm: true,
      exportToken: WALLET_EXPORT_TOKEN,
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
