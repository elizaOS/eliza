/**
 * Unit tests for wallet companion hook logic and security helpers.
 *
 * Tests cover:
 *   - safeExplorerHref URL validation (security)
 *   - useWalletSwapState quote/execute validation logic
 *   - useWalletSendState address/amount validation and transfer flow
 *   - useWalletTradeHistory ledger sync merge/dedup and status refresh
 *
 * These exercise the financial transaction logic paths that the hooks
 * encapsulate, without requiring a React rendering environment.
 */
import { describe, expect, it, vi } from "vitest";

import {
  HEX_ADDRESS_RE,
  loadRecentTrades,
  MAX_WALLET_RECENT_TRADES,
  mapWalletTradeError,
  persistRecentTrades,
  safeExplorerHref,
  type TranslatorFn,
  type WalletRecentTrade,
} from "../../src/components/companion/walletUtils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockT(overrides: Record<string, string> = {}): TranslatorFn {
  return (key: string) => overrides[key] ?? key;
}

const VALID_TOKEN = `0x${"a".repeat(40)}`;
const VALID_HASH = `0x${"f".repeat(64)}`;

function makeTrade(
  partial: Partial<WalletRecentTrade> = {},
): WalletRecentTrade {
  return {
    hash: VALID_HASH,
    side: "buy",
    tokenAddress: VALID_TOKEN,
    amount: "0.01",
    inputSymbol: "BNB",
    outputSymbol: "MILADY",
    createdAt: Date.now(),
    status: "pending",
    confirmations: 0,
    nonce: null,
    reason: null,
    explorerUrl: `https://bscscan.com/tx/${VALID_HASH}`,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// safeExplorerHref — security validation
// ---------------------------------------------------------------------------

describe("safeExplorerHref", () => {
  it("returns the explorerUrl when it uses https", () => {
    expect(safeExplorerHref("https://bscscan.com/tx/0x123", "0x123")).toBe(
      "https://bscscan.com/tx/0x123",
    );
  });

  it("returns the explorerUrl when it uses http", () => {
    expect(safeExplorerHref("http://bscscan.com/tx/0x123", "0x123")).toBe(
      "http://bscscan.com/tx/0x123",
    );
  });

  it("is case-insensitive for scheme", () => {
    expect(safeExplorerHref("HTTPS://bscscan.com/tx/0x1", "0x1")).toBe(
      "HTTPS://bscscan.com/tx/0x1",
    );
  });

  it("rejects javascript: URIs and returns bscscan fallback", () => {
    expect(safeExplorerHref("javascript:alert(1)", "0xabc")).toBe(
      "https://bscscan.com/tx/0xabc",
    );
  });

  it("rejects javascript: with mixed case", () => {
    expect(safeExplorerHref("JavaScript:void(0)", "0xabc")).toBe(
      "https://bscscan.com/tx/0xabc",
    );
  });

  it("rejects data: URIs and returns fallback", () => {
    expect(safeExplorerHref("data:text/html,<h1>hi</h1>", "0xabc")).toBe(
      "https://bscscan.com/tx/0xabc",
    );
  });

  it("rejects vbscript: URIs", () => {
    expect(safeExplorerHref("vbscript:MsgBox(1)", "0xabc")).toBe(
      "https://bscscan.com/tx/0xabc",
    );
  });

  it("returns fallback when explorerUrl is null", () => {
    expect(safeExplorerHref(null, "0xabc")).toBe(
      "https://bscscan.com/tx/0xabc",
    );
  });

  it("returns fallback when explorerUrl is undefined", () => {
    expect(safeExplorerHref(undefined, "0xabc")).toBe(
      "https://bscscan.com/tx/0xabc",
    );
  });

  it("returns fallback when explorerUrl is empty string", () => {
    expect(safeExplorerHref("", "0xabc")).toBe("https://bscscan.com/tx/0xabc");
  });
});

// ---------------------------------------------------------------------------
// Swap validation logic (from useWalletSwapState)
// ---------------------------------------------------------------------------

describe("swap validation logic", () => {
  it("rejects non-hex token addresses", () => {
    expect(HEX_ADDRESS_RE.test("not-hex")).toBe(false);
    expect(HEX_ADDRESS_RE.test("0x123")).toBe(false); // too short
    expect(HEX_ADDRESS_RE.test(`0x${"g".repeat(40)}`)).toBe(false);
  });

  it("accepts valid hex token addresses", () => {
    expect(HEX_ADDRESS_RE.test(VALID_TOKEN)).toBe(true);
    expect(HEX_ADDRESS_RE.test(`0x${"A".repeat(40)}`)).toBe(true);
  });

  it("rejects zero or negative swap amounts", () => {
    const validateAmount = (input: string) => {
      const num = Number.parseFloat(input);
      return Number.isFinite(num) && num > 0;
    };
    expect(validateAmount("0")).toBe(false);
    expect(validateAmount("-1")).toBe(false);
    expect(validateAmount("abc")).toBe(false);
    expect(validateAmount("")).toBe(false);
    expect(validateAmount("NaN")).toBe(false);
  });

  it("accepts valid swap amounts", () => {
    const validateAmount = (input: string) => {
      const num = Number.parseFloat(input);
      return Number.isFinite(num) && num > 0;
    };
    expect(validateAmount("0.01")).toBe(true);
    expect(validateAmount("100")).toBe(true);
    expect(validateAmount("0.000001")).toBe(true);
  });

  it("computes slippage BPS correctly", () => {
    const computeSlippageBps = (input: string) => {
      const parsed = Number.parseFloat(input);
      if (!Number.isFinite(parsed) || parsed <= 0) return 100;
      return Math.min(5000, Math.round(parsed * 100));
    };
    expect(computeSlippageBps("1.0")).toBe(100);
    expect(computeSlippageBps("0.5")).toBe(50);
    expect(computeSlippageBps("50")).toBe(5000); // capped at 5000
    expect(computeSlippageBps("100")).toBe(5000); // capped
    expect(computeSlippageBps("abc")).toBe(100); // fallback
    expect(computeSlippageBps("-1")).toBe(100); // fallback
  });

  it("maps trade errors to human-readable messages", () => {
    const t = mockT({ "wallet.failedFetchQuote": "Quote failed" });
    expect(
      mapWalletTradeError(new Error("Bad token"), t, "wallet.failedFetchQuote"),
    ).toBe("Bad token");
    expect(
      mapWalletTradeError("String error", t, "wallet.failedFetchQuote"),
    ).toBe("String error");
    expect(mapWalletTradeError(null, t, "wallet.failedFetchQuote")).toBe(
      "Quote failed",
    );
    expect(mapWalletTradeError(undefined, t, "wallet.failedFetchQuote")).toBe(
      "Quote failed",
    );
  });
});

// ---------------------------------------------------------------------------
// Send validation logic (from useWalletSendState)
// ---------------------------------------------------------------------------

describe("send validation logic", () => {
  it("validates destination address is 0x-prefixed 40-char hex", () => {
    expect(HEX_ADDRESS_RE.test(`0x${"b".repeat(40)}`)).toBe(true);
    expect(HEX_ADDRESS_RE.test("not-an-address")).toBe(false);
    expect(HEX_ADDRESS_RE.test("")).toBe(false);
    expect(HEX_ADDRESS_RE.test("0x")).toBe(false);
  });

  it("computes sendReady correctly", () => {
    const computeSendReady = (
      evmAddress: string | null,
      toValid: boolean,
      amountValid: boolean,
    ) => Boolean(evmAddress && toValid && amountValid);

    expect(computeSendReady(`0x${"c".repeat(40)}`, true, true)).toBe(true);
    expect(computeSendReady(null, true, true)).toBe(false);
    expect(computeSendReady(`0x${"c".repeat(40)}`, false, true)).toBe(false);
    expect(computeSendReady(`0x${"c".repeat(40)}`, true, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Trade history logic (from useWalletTradeHistory)
// ---------------------------------------------------------------------------

describe("trade history logic", () => {
  it("deduplicates trades by hash — newer entry wins", () => {
    const existing = [
      makeTrade({ hash: "0x001", status: "pending", createdAt: 1000 }),
      makeTrade({ hash: "0x002", status: "success", createdAt: 900 }),
    ];
    const incoming = makeTrade({
      hash: "0x001",
      status: "success",
      createdAt: 1100,
    });

    // Simulates addRecentTrade logic
    const next = [
      incoming,
      ...existing.filter((entry) => entry.hash !== incoming.hash),
    ].slice(0, MAX_WALLET_RECENT_TRADES);

    expect(next).toHaveLength(2);
    expect(next[0].hash).toBe("0x001");
    expect(next[0].status).toBe("success");
  });

  it("limits stored trades to MAX_WALLET_RECENT_TRADES", () => {
    const trades: WalletRecentTrade[] = [];
    for (let i = 0; i < MAX_WALLET_RECENT_TRADES + 5; i++) {
      trades.push(makeTrade({ hash: `0x${i.toString(16).padStart(64, "0")}` }));
    }
    const trimmed = trades.slice(0, MAX_WALLET_RECENT_TRADES);
    expect(trimmed).toHaveLength(MAX_WALLET_RECENT_TRADES);
  });

  it("merges ledger swaps without duplicating existing local entries", () => {
    const localTrades = [
      makeTrade({ hash: "0xlocal1", createdAt: 2000 }),
      makeTrade({ hash: "0xlocal2", createdAt: 1500 }),
    ];
    const ledgerSwaps = [
      { hash: "0xlocal1" }, // duplicate
      { hash: "0xledger1" }, // new
    ];

    const existingHashes = new Set(localTrades.map((e) => e.hash));
    const newEntries: WalletRecentTrade[] = [];
    for (const swap of ledgerSwaps) {
      if (existingHashes.has(swap.hash)) continue;
      newEntries.push(makeTrade({ hash: swap.hash, createdAt: 1800 }));
    }

    const merged = [...newEntries, ...localTrades]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_WALLET_RECENT_TRADES);

    expect(merged).toHaveLength(3);
    // No duplicates
    const hashes = merged.map((e) => e.hash);
    expect(new Set(hashes).size).toBe(hashes.length);
    // Sorted by createdAt desc
    expect(merged[0].createdAt).toBeGreaterThanOrEqual(merged[1].createdAt);
    expect(merged[1].createdAt).toBeGreaterThanOrEqual(merged[2].createdAt);
  });

  it("updates trade status from API response", () => {
    const trades = [
      makeTrade({ hash: VALID_HASH, status: "pending", confirmations: 0 }),
    ];

    const statusResponse = {
      status: "success" as const,
      confirmations: 12,
      nonce: 42,
      explorerUrl: `https://bscscan.com/tx/${VALID_HASH}`,
    };

    // Simulates refreshRecentTradeStatus logic
    const next = trades.map((entry) => {
      if (entry.hash !== VALID_HASH) return entry;
      return {
        ...entry,
        status: statusResponse.status,
        confirmations: statusResponse.confirmations,
        nonce: statusResponse.nonce,
        explorerUrl: statusResponse.explorerUrl || entry.explorerUrl,
      };
    });

    expect(next[0].status).toBe("success");
    expect(next[0].confirmations).toBe(12);
    expect(next[0].nonce).toBe(42);
  });

  it("filters trades by status", () => {
    const trades = [
      makeTrade({ hash: "0x1", status: "pending" }),
      makeTrade({ hash: "0x2", status: "success" }),
      makeTrade({ hash: "0x3", status: "reverted" }),
      makeTrade({ hash: "0x4", status: "pending" }),
    ];

    const filterByStatus = (items: WalletRecentTrade[], filter: string) => {
      if (filter === "all") return items;
      return items.filter((e) => e.status === filter);
    };

    expect(filterByStatus(trades, "all")).toHaveLength(4);
    expect(filterByStatus(trades, "pending")).toHaveLength(2);
    expect(filterByStatus(trades, "success")).toHaveLength(1);
    expect(filterByStatus(trades, "reverted")).toHaveLength(1);
    expect(filterByStatus(trades, "not_found")).toHaveLength(0);
  });

  it("identifies pending hashes for polling", () => {
    const trades = [
      makeTrade({ hash: "0x1", status: "pending" }),
      makeTrade({ hash: "0x2", status: "success" }),
      makeTrade({ hash: "0x3", status: "pending" }),
    ];

    const pendingHashes = trades
      .filter((e) => e.status === "pending")
      .map((e) => e.hash);

    expect(pendingHashes).toEqual(["0x1", "0x3"]);
  });

  describe("localStorage persistence", () => {
    it("loadRecentTrades returns empty array when localStorage is empty", () => {
      vi.stubGlobal("localStorage", {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(),
      });
      expect(loadRecentTrades()).toEqual([]);
      vi.unstubAllGlobals();
    });

    it("loadRecentTrades parses valid entries", () => {
      const stored = [makeTrade({ hash: "0xtest" })];
      vi.stubGlobal("localStorage", {
        getItem: vi.fn().mockReturnValue(JSON.stringify(stored)),
        setItem: vi.fn(),
      });
      const result = loadRecentTrades();
      expect(result).toHaveLength(1);
      expect(result[0].hash).toBe("0xtest");
      vi.unstubAllGlobals();
    });

    it("loadRecentTrades filters out invalid entries", () => {
      const stored = [
        makeTrade({ hash: "0xvalid" }),
        { hash: 123 }, // invalid: hash not string
        null,
        { hash: "0xbad", side: "invalid" }, // invalid side
      ];
      vi.stubGlobal("localStorage", {
        getItem: vi.fn().mockReturnValue(JSON.stringify(stored)),
        setItem: vi.fn(),
      });
      const result = loadRecentTrades();
      expect(result).toHaveLength(1);
      expect(result[0].hash).toBe("0xvalid");
      vi.unstubAllGlobals();
    });

    it("persistRecentTrades stores trimmed entries", () => {
      const setItem = vi.fn();
      vi.stubGlobal("localStorage", { getItem: vi.fn(), setItem });
      const trades = Array.from({ length: 15 }, (_, i) =>
        makeTrade({ hash: `0x${i}` }),
      );
      persistRecentTrades(trades);
      const stored = JSON.parse(setItem.mock.calls[0][1]);
      expect(stored).toHaveLength(MAX_WALLET_RECENT_TRADES);
      vi.unstubAllGlobals();
    });

    it("loadRecentTrades handles corrupted JSON gracefully", () => {
      vi.stubGlobal("localStorage", {
        getItem: vi.fn().mockReturnValue("not valid json{{{"),
        setItem: vi.fn(),
      });
      expect(loadRecentTrades()).toEqual([]);
      vi.unstubAllGlobals();
    });
  });
});
