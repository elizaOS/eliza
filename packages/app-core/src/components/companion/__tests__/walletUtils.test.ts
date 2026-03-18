/**
 * Unit tests for walletUtils pure utility functions.
 *
 * No DOM or network access required — fetch and localStorage are mocked
 * where needed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BSC_GAS_READY_THRESHOLD,
  BSC_SWAP_GAS_RESERVE,
  fetchBscTokenMetadata,
  formatRouteAddress,
  getRecentTradeGroupKey,
  getTokenExplorerUrl,
  getWalletTxStatusLabel,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
  loadRecentTrades,
  MAX_WALLET_RECENT_TRADES,
  mapWalletTradeError,
  persistRecentTrades,
  resolvePortfolioChainKey,
  shortHash,
  type TranslatorFn,
  WALLET_RECENT_TRADES_KEY,
  type WalletRecentTrade,
  type WalletTokenRow,
} from "../walletUtils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple translator stub that returns the key unless overridden. */
function mockTranslator(overrides: Record<string, string> = {}): TranslatorFn {
  return (key: string) => overrides[key] ?? key;
}

/** Build a minimal WalletTokenRow for getTokenExplorerUrl tests. */
function makeTokenRow(
  partial: Partial<WalletTokenRow> & Pick<WalletTokenRow, "chainKey" | "chain">,
): WalletTokenRow {
  return {
    key: "test-key",
    symbol: "TST",
    name: "Test Token",
    assetAddress: `0x${"a".repeat(40)}`,
    isNative: false,
    valueUsd: 0,
    balance: "0",
    logoUrl: null,
    ...partial,
  };
}

/** Build a minimal WalletRecentTrade for persistence tests. */
function makeTrade(
  partial: Partial<WalletRecentTrade> = {},
): WalletRecentTrade {
  return {
    hash: `0x${"f".repeat(64)}`,
    side: "buy",
    tokenAddress: `0x${"a".repeat(40)}`,
    amount: "1.5",
    inputSymbol: "BNB",
    outputSymbol: "ELIZA",
    createdAt: Date.now(),
    status: "success",
    confirmations: 12,
    nonce: 1,
    reason: null,
    explorerUrl: "https://bscscan.com/tx/0x123",
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("walletUtils", () => {
  // ── getWalletTxStatusLabel ────────────────────────────────────────
  describe("getWalletTxStatusLabel", () => {
    it("returns the translated value when translation exists", () => {
      const t = mockTranslator({ "wallet.txStatus.pending": "Pending..." });
      expect(getWalletTxStatusLabel("pending", t)).toBe("Pending...");
    });

    it("returns the raw status when translation key matches output (no translation found)", () => {
      const t = mockTranslator(); // returns key as-is
      expect(getWalletTxStatusLabel("pending", t)).toBe("pending");
    });

    it("returns the raw status for unknown status values", () => {
      const t = mockTranslator();
      expect(getWalletTxStatusLabel("unknown_status", t)).toBe(
        "unknown_status",
      );
    });
  });

  // ── mapWalletTradeError ───────────────────────────────────────────
  describe("mapWalletTradeError", () => {
    it("returns Error.message when err is an Error", () => {
      const t = mockTranslator();
      expect(mapWalletTradeError(new Error("boom"), t, "fallback")).toBe(
        "boom",
      );
    });

    it("returns the string directly when err is a non-empty string", () => {
      const t = mockTranslator();
      expect(mapWalletTradeError("something broke", t, "fallback")).toBe(
        "something broke",
      );
    });

    it("returns translated fallback for empty string", () => {
      const t = mockTranslator({ "wallet.error": "Something went wrong" });
      expect(mapWalletTradeError("", t, "wallet.error")).toBe(
        "Something went wrong",
      );
    });

    it("returns translated fallback for null/undefined", () => {
      const t = mockTranslator({ fb: "Fallback" });
      expect(mapWalletTradeError(null, t, "fb")).toBe("Fallback");
      expect(mapWalletTradeError(undefined, t, "fb")).toBe("Fallback");
    });

    it("returns translated fallback for non-Error objects", () => {
      const t = mockTranslator({ fb: "Fallback" });
      expect(mapWalletTradeError({ code: 42 }, t, "fb")).toBe("Fallback");
    });
  });

  // ── HEX_ADDRESS_RE ────────────────────────────────────────────────
  describe("HEX_ADDRESS_RE", () => {
    it("matches valid 0x-prefixed 40-hex-char addresses", () => {
      expect(HEX_ADDRESS_RE.test(`0x${"a".repeat(40)}`)).toBe(true);
      expect(HEX_ADDRESS_RE.test(`0x${"A".repeat(40)}`)).toBe(true);
      expect(HEX_ADDRESS_RE.test(`0x${"0123456789abcdefABCD".repeat(2)}`)).toBe(
        true,
      );
    });

    it("rejects addresses with wrong length", () => {
      expect(HEX_ADDRESS_RE.test(`0x${"a".repeat(39)}`)).toBe(false);
      expect(HEX_ADDRESS_RE.test(`0x${"a".repeat(41)}`)).toBe(false);
    });

    it("rejects addresses without 0x prefix", () => {
      expect(HEX_ADDRESS_RE.test("a".repeat(40))).toBe(false);
    });

    it("rejects addresses with non-hex characters", () => {
      expect(HEX_ADDRESS_RE.test(`0x${"g".repeat(40)}`)).toBe(false);
      expect(HEX_ADDRESS_RE.test(`0x${"z".repeat(40)}`)).toBe(false);
    });

    it("rejects empty string", () => {
      expect(HEX_ADDRESS_RE.test("")).toBe(false);
    });
  });

  // ── isBscChainName ────────────────────────────────────────────────
  describe("isBscChainName", () => {
    it("recognizes 'bsc' (case-insensitive)", () => {
      expect(isBscChainName("bsc")).toBe(true);
      expect(isBscChainName("BSC")).toBe(true);
      expect(isBscChainName("Bsc")).toBe(true);
    });

    it("recognizes 'bnb chain' variants", () => {
      expect(isBscChainName("bnb chain")).toBe(true);
      expect(isBscChainName("BNB Chain")).toBe(true);
    });

    it("recognizes 'bnb smart chain' variants", () => {
      expect(isBscChainName("bnb smart chain")).toBe(true);
      expect(isBscChainName("BNB Smart Chain")).toBe(true);
    });

    it("trims whitespace", () => {
      expect(isBscChainName("  bsc  ")).toBe(true);
    });

    it("rejects non-BSC chains", () => {
      expect(isBscChainName("ethereum")).toBe(false);
      expect(isBscChainName("solana")).toBe(false);
      expect(isBscChainName("polygon")).toBe(false);
      expect(isBscChainName("avalanche")).toBe(false);
      expect(isBscChainName("")).toBe(false);
    });
  });

  // ── isAvaxChainName ───────────────────────────────────────────────
  describe("isAvaxChainName", () => {
    it("recognizes 'avax' (case-insensitive)", () => {
      expect(isAvaxChainName("avax")).toBe(true);
      expect(isAvaxChainName("AVAX")).toBe(true);
      expect(isAvaxChainName("Avax")).toBe(true);
    });

    it("recognizes 'avalanche' variants", () => {
      expect(isAvaxChainName("avalanche")).toBe(true);
      expect(isAvaxChainName("Avalanche")).toBe(true);
    });

    it("recognizes 'c-chain' variants", () => {
      expect(isAvaxChainName("c-chain")).toBe(true);
      expect(isAvaxChainName("avalanche c-chain")).toBe(true);
    });

    it("trims whitespace", () => {
      expect(isAvaxChainName("  avax  ")).toBe(true);
    });

    it("rejects non-AVAX chains", () => {
      expect(isAvaxChainName("ethereum")).toBe(false);
      expect(isAvaxChainName("bsc")).toBe(false);
      expect(isAvaxChainName("solana")).toBe(false);
      expect(isAvaxChainName("")).toBe(false);
    });
  });

  // ── resolvePortfolioChainKey ──────────────────────────────────────
  describe("resolvePortfolioChainKey", () => {
    it("returns 'bsc' for BSC chain names", () => {
      expect(resolvePortfolioChainKey("bsc")).toBe("bsc");
      expect(resolvePortfolioChainKey("BNB Chain")).toBe("bsc");
      expect(resolvePortfolioChainKey("BNB Smart Chain")).toBe("bsc");
    });

    it("returns 'solana' for Solana variants", () => {
      expect(resolvePortfolioChainKey("solana")).toBe("solana");
      expect(resolvePortfolioChainKey("Solana")).toBe("solana");
      expect(resolvePortfolioChainKey("sol")).toBe("solana");
    });

    it("returns 'avax' for Avalanche variants", () => {
      expect(resolvePortfolioChainKey("avax")).toBe("avax");
      expect(resolvePortfolioChainKey("Avalanche")).toBe("avax");
      expect(resolvePortfolioChainKey("c-chain")).toBe("avax");
    });

    it("returns 'evm' for other chains", () => {
      expect(resolvePortfolioChainKey("ethereum")).toBe("evm");
      expect(resolvePortfolioChainKey("base")).toBe("evm");
      expect(resolvePortfolioChainKey("polygon")).toBe("evm");
      expect(resolvePortfolioChainKey("arbitrum")).toBe("evm");
    });
  });

  // ── formatRouteAddress ────────────────────────────────────────────
  describe("formatRouteAddress", () => {
    it("returns short addresses unchanged", () => {
      expect(formatRouteAddress("0x1234")).toBe("0x1234");
    });

    it("returns addresses at exactly 14 chars unchanged", () => {
      const addr = "0x12345678abcd"; // 14 chars
      expect(formatRouteAddress(addr)).toBe(addr);
    });

    it("truncates long addresses to 6...4 format", () => {
      const full = `0x${"a".repeat(40)}`;
      expect(formatRouteAddress(full)).toBe("0xaaaa...aaaa");
    });

    it("trims whitespace before measuring length", () => {
      const full = `  0x${"a".repeat(40)}  `;
      const result = formatRouteAddress(full);
      expect(result).toBe("0xaaaa...aaaa");
    });
  });

  // ── shortHash ─────────────────────────────────────────────────────
  describe("shortHash", () => {
    it("returns short hashes unchanged", () => {
      expect(shortHash("0x1234")).toBe("0x1234");
    });

    it("returns hashes at exactly 14 chars unchanged", () => {
      expect(shortHash("0x12345678abcd")).toBe("0x12345678abcd");
    });

    it("truncates long hashes to 8...6 format", () => {
      const hash = `0x${"f".repeat(64)}`;
      expect(shortHash(hash)).toBe("0xffffff...ffffff");
    });
  });

  // ── getTokenExplorerUrl ───────────────────────────────────────────
  describe("getTokenExplorerUrl", () => {
    const validAddr = `0x${"a".repeat(40)}`;

    it("returns null when assetAddress is null", () => {
      const row = makeTokenRow({
        chainKey: "bsc",
        chain: "bsc",
        assetAddress: null,
      });
      expect(getTokenExplorerUrl(row)).toBeNull();
    });

    it("returns bscscan URL for BSC chain", () => {
      const row = makeTokenRow({
        chainKey: "evm",
        chain: "BSC",
        assetAddress: validAddr,
      });
      expect(getTokenExplorerUrl(row)).toBe(
        `https://bscscan.com/token/${validAddr}`,
      );
    });

    it("returns bscscan URL for 'BNB Chain'", () => {
      const row = makeTokenRow({
        chainKey: "evm",
        chain: "BNB Chain",
        assetAddress: validAddr,
      });
      expect(getTokenExplorerUrl(row)).toBe(
        `https://bscscan.com/token/${validAddr}`,
      );
    });

    it("returns etherscan URL for Ethereum", () => {
      const row = makeTokenRow({
        chainKey: "evm",
        chain: "ethereum",
        assetAddress: validAddr,
      });
      expect(getTokenExplorerUrl(row)).toBe(
        `https://etherscan.io/token/${validAddr}`,
      );
    });

    it("returns etherscan URL for 'mainnet'", () => {
      const row = makeTokenRow({
        chainKey: "evm",
        chain: "mainnet",
        assetAddress: validAddr,
      });
      expect(getTokenExplorerUrl(row)).toBe(
        `https://etherscan.io/token/${validAddr}`,
      );
    });

    it("returns basescan URL for Base chain", () => {
      const row = makeTokenRow({
        chainKey: "evm",
        chain: "base",
        assetAddress: validAddr,
      });
      expect(getTokenExplorerUrl(row)).toBe(
        `https://basescan.org/token/${validAddr}`,
      );
    });

    it("returns arbiscan URL for Arbitrum", () => {
      const row = makeTokenRow({
        chainKey: "evm",
        chain: "arbitrum",
        assetAddress: validAddr,
      });
      expect(getTokenExplorerUrl(row)).toBe(
        `https://arbiscan.io/token/${validAddr}`,
      );
    });

    it("returns optimistic etherscan URL for Optimism", () => {
      const row = makeTokenRow({
        chainKey: "evm",
        chain: "optimism",
        assetAddress: validAddr,
      });
      expect(getTokenExplorerUrl(row)).toBe(
        `https://optimistic.etherscan.io/token/${validAddr}`,
      );
    });

    it("returns polygonscan URL for Polygon", () => {
      const row = makeTokenRow({
        chainKey: "evm",
        chain: "polygon",
        assetAddress: validAddr,
      });
      expect(getTokenExplorerUrl(row)).toBe(
        `https://polygonscan.com/token/${validAddr}`,
      );
    });

    it("returns solscan URL for Solana tokens", () => {
      const solAddr = "So11111111111111111111111111111111111111112";
      const row = makeTokenRow({
        chainKey: "solana",
        chain: "solana",
        assetAddress: solAddr,
      });
      expect(getTokenExplorerUrl(row)).toBe(
        `https://solscan.io/token/${solAddr}`,
      );
    });

    it("returns null for Solana with invalid address", () => {
      const row = makeTokenRow({
        chainKey: "solana",
        chain: "solana",
        assetAddress: "invalid!",
      });
      expect(getTokenExplorerUrl(row)).toBeNull();
    });

    it("returns null for EVM with invalid hex address", () => {
      const row = makeTokenRow({
        chainKey: "evm",
        chain: "ethereum",
        assetAddress: "not-an-address",
      });
      expect(getTokenExplorerUrl(row)).toBeNull();
    });

    it("returns null for an unsupported EVM chain", () => {
      const row = makeTokenRow({
        chainKey: "evm",
        chain: "fantom",
        assetAddress: validAddr,
      });
      expect(getTokenExplorerUrl(row)).toBeNull();
    });

    it("returns snowtrace URL for Avalanche", () => {
      const row = makeTokenRow({
        chainKey: "avax",
        chain: "avalanche",
        assetAddress: validAddr,
      });
      expect(getTokenExplorerUrl(row)).toBe(
        `https://snowtrace.io/token/${validAddr}`,
      );
    });

    it("returns snowtrace URL for 'avax'", () => {
      const row = makeTokenRow({
        chainKey: "avax",
        chain: "avax",
        assetAddress: validAddr,
      });
      expect(getTokenExplorerUrl(row)).toBe(
        `https://snowtrace.io/token/${validAddr}`,
      );
    });
  });

  // ── getRecentTradeGroupKey ────────────────────────────────────────
  describe("getRecentTradeGroupKey", () => {
    it("returns 'today' for a trade created today", () => {
      const now = new Date(2026, 2, 4, 15, 0, 0).getTime(); // March 4, 2026 3pm
      const createdAt = new Date(2026, 2, 4, 8, 0, 0).getTime(); // same day 8am
      expect(getRecentTradeGroupKey(createdAt, now)).toBe("today");
    });

    it("returns 'yesterday' for a trade created yesterday", () => {
      const now = new Date(2026, 2, 4, 15, 0, 0).getTime();
      const createdAt = new Date(2026, 2, 3, 20, 0, 0).getTime(); // day before
      expect(getRecentTradeGroupKey(createdAt, now)).toBe("yesterday");
    });

    it("returns 'earlier' for a trade created 2+ days ago", () => {
      const now = new Date(2026, 2, 4, 15, 0, 0).getTime();
      const createdAt = new Date(2026, 2, 1, 10, 0, 0).getTime(); // 3 days ago
      expect(getRecentTradeGroupKey(createdAt, now)).toBe("earlier");
    });

    it("returns 'today' for a trade at midnight start-of-day boundary", () => {
      const now = new Date(2026, 2, 4, 0, 0, 1).getTime(); // just after midnight
      const createdAt = new Date(2026, 2, 4, 0, 0, 0).getTime(); // exact midnight
      expect(getRecentTradeGroupKey(createdAt, now)).toBe("today");
    });
  });

  // ── loadRecentTrades / persistRecentTrades ────────────────────────
  describe("loadRecentTrades / persistRecentTrades", () => {
    let storage: Record<string, string>;

    beforeEach(() => {
      storage = {};
      vi.stubGlobal("localStorage", {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value;
        }),
        removeItem: vi.fn((key: string) => {
          delete storage[key];
        }),
      });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns empty array when localStorage has no data", () => {
      expect(loadRecentTrades()).toEqual([]);
    });

    it("returns empty array when localStorage contains invalid JSON", () => {
      storage[WALLET_RECENT_TRADES_KEY] = "{not json";
      expect(loadRecentTrades()).toEqual([]);
    });

    it("returns empty array when stored value is not an array", () => {
      storage[WALLET_RECENT_TRADES_KEY] = JSON.stringify({ foo: "bar" });
      expect(loadRecentTrades()).toEqual([]);
    });

    it("filters out invalid entries from stored array", () => {
      const valid = makeTrade();
      const invalid = { hash: 123, side: "buy" }; // hash is not a string
      storage[WALLET_RECENT_TRADES_KEY] = JSON.stringify([valid, invalid]);
      const result = loadRecentTrades();
      expect(result).toHaveLength(1);
      expect(result[0].hash).toBe(valid.hash);
    });

    it("filters out entries with invalid side values", () => {
      const bad = makeTrade({ side: "swap" as "buy" });
      storage[WALLET_RECENT_TRADES_KEY] = JSON.stringify([bad]);
      expect(loadRecentTrades()).toHaveLength(0);
    });

    it("caps loaded trades at MAX_WALLET_RECENT_TRADES", () => {
      const trades = Array.from({ length: 15 }, (_, i) =>
        makeTrade({ hash: `0x${i.toString(16).padStart(64, "0")}` }),
      );
      storage[WALLET_RECENT_TRADES_KEY] = JSON.stringify(trades);
      expect(loadRecentTrades()).toHaveLength(MAX_WALLET_RECENT_TRADES);
    });

    it("persistRecentTrades writes valid JSON to localStorage", () => {
      const trade = makeTrade();
      persistRecentTrades([trade]);
      const stored = JSON.parse(storage[WALLET_RECENT_TRADES_KEY]);
      expect(stored).toHaveLength(1);
      expect(stored[0].hash).toBe(trade.hash);
    });

    it("persistRecentTrades caps at MAX_WALLET_RECENT_TRADES", () => {
      const trades = Array.from({ length: 15 }, (_, i) =>
        makeTrade({ hash: `0x${i.toString(16).padStart(64, "0")}` }),
      );
      persistRecentTrades(trades);
      const stored = JSON.parse(storage[WALLET_RECENT_TRADES_KEY]);
      expect(stored).toHaveLength(MAX_WALLET_RECENT_TRADES);
    });

    it("round-trips: persistRecentTrades then loadRecentTrades", () => {
      const trade = makeTrade();
      persistRecentTrades([trade]);
      const loaded = loadRecentTrades();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].hash).toBe(trade.hash);
      expect(loaded[0].side).toBe(trade.side);
      expect(loaded[0].status).toBe(trade.status);
    });
  });

  // ── fetchBscTokenMetadata ─────────────────────────────────────────
  describe("fetchBscTokenMetadata", () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("returns null for invalid hex address", async () => {
      const result = await fetchBscTokenMetadata("not-an-address");
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("returns null for empty address", async () => {
      const result = await fetchBscTokenMetadata("");
      expect(result).toBeNull();
    });

    it("returns metadata on successful response with matching BSC pair", async () => {
      const contractAddr = `0x${"a".repeat(40)}`;
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          pairs: [
            {
              chainId: "bsc",
              baseToken: {
                address: contractAddr,
                symbol: "TEST",
                name: "Test Token",
              },
              quoteToken: { address: `0x${"b".repeat(40)}` },
              info: { imageUrl: "https://example.com/logo.png" },
            },
          ],
        }),
      });

      const result = await fetchBscTokenMetadata(contractAddr);
      expect(result).toEqual({
        symbol: "TEST",
        name: "Test Token",
        logoUrl: "https://example.com/logo.png",
      });
    });

    it("returns null when no BSC pair is found", async () => {
      const contractAddr = `0x${"a".repeat(40)}`;
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          pairs: [
            {
              chainId: "ethereum",
              baseToken: { address: contractAddr, symbol: "TST", name: "Test" },
            },
          ],
        }),
      });

      const result = await fetchBscTokenMetadata(contractAddr);
      expect(result).toBeNull();
    });

    it("returns null when response is not ok", async () => {
      const contractAddr = `0x${"a".repeat(40)}`;
      fetchMock.mockResolvedValueOnce({
        ok: false,
        json: async () => ({}),
      });

      const result = await fetchBscTokenMetadata(contractAddr);
      expect(result).toBeNull();
    });

    it("returns null when fetch throws (network error)", async () => {
      const contractAddr = `0x${"a".repeat(40)}`;
      fetchMock.mockRejectedValueOnce(new Error("Network failure"));

      const result = await fetchBscTokenMetadata(contractAddr);
      expect(result).toBeNull();
    });

    it("uses quoteToken when quoteToken address matches", async () => {
      const contractAddr = `0x${"c".repeat(40)}`;
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          pairs: [
            {
              chainId: "bsc",
              baseToken: {
                address: `0x${"d".repeat(40)}`,
                symbol: "BASE",
                name: "Base Token",
              },
              quoteToken: {
                address: contractAddr,
                symbol: "QUOTE",
                name: "Quote Token",
              },
              info: { imageUrl: "https://example.com/quote.png" },
            },
          ],
        }),
      });

      const result = await fetchBscTokenMetadata(contractAddr);
      expect(result).toEqual({
        symbol: "QUOTE",
        name: "Quote Token",
        logoUrl: "https://example.com/quote.png",
      });
    });

    it("falls back to default symbol/name when token ref fields are empty", async () => {
      const contractAddr = `0x${"a".repeat(40)}`;
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          pairs: [
            {
              chainId: "bsc",
              baseToken: { address: contractAddr, symbol: "", name: "" },
              info: {},
            },
          ],
        }),
      });

      const result = await fetchBscTokenMetadata(contractAddr);
      expect(result).toEqual({
        symbol: "TOKEN",
        name: "Unknown Token",
        logoUrl: null,
      });
    });

    it("returns null when pairs is not an array", async () => {
      const contractAddr = `0x${"a".repeat(40)}`;
      fetchMock.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ pairs: "not-array" }),
      });

      const result = await fetchBscTokenMetadata(contractAddr);
      expect(result).toBeNull();
    });
  });

  // ── exported constants ────────────────────────────────────────────
  describe("exported constants", () => {
    it("BSC_GAS_READY_THRESHOLD is a positive number", () => {
      expect(BSC_GAS_READY_THRESHOLD).toBeGreaterThan(0);
    });

    it("BSC_SWAP_GAS_RESERVE is less than BSC_GAS_READY_THRESHOLD", () => {
      expect(BSC_SWAP_GAS_RESERVE).toBeLessThan(BSC_GAS_READY_THRESHOLD);
    });

    it("MAX_WALLET_RECENT_TRADES is 10", () => {
      expect(MAX_WALLET_RECENT_TRADES).toBe(10);
    });
  });
});
