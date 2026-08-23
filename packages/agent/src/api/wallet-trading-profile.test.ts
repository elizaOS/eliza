/**
 * Behavioral coverage for the on-disk wallet trade ledger and the derived
 * trading-profile analytics: persistence, status transitions, FIFO PnL,
 * window/source filters, ordering, capacity, and empty/single-element cases.
 * Drives the real module against a temp state directory — no mocked returns.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  WalletTradeLedgerEntry,
  WalletTradingProfileSourceFilter,
  WalletTradingProfileWindow,
} from "@elizaos/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildWalletTradingProfile,
  loadWalletTradingProfile,
  readWalletTradeLedgerStore,
  recordWalletTradeLedgerEntry,
  resolveWalletTradingProfileFilePath,
  updateWalletTradeLedgerEntryStatus,
  type WalletTradeLedgerRecordInput,
  type WalletTradeLedgerStatusPatch,
  writeWalletTradeLedgerStore,
} from "./wallet-trading-profile.ts";

const TOKEN_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const BNB_WEI = "1000000000000000000";
const TOKEN_WEI = "100000000000000000000";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wallet-trading-profile-"));
  tempDirs.push(dir);
  return dir;
}

function bnbLeg(amount: string, symbol = "BNB") {
  return { symbol, amount, amountWei: BNB_WEI };
}

function tokenLeg(amount: string, symbol = "TKN") {
  return { symbol, amount, amountWei: TOKEN_WEI };
}

function makeInput(overrides: {
  hash: string;
  side?: WalletTradeLedgerRecordInput["side"];
  source?: WalletTradeLedgerRecordInput["source"];
  status?: WalletTradeLedgerRecordInput["status"];
  tokenAddress?: string;
  slippageBps?: number;
  route?: string[];
  quoteIn?: WalletTradeLedgerRecordInput["quoteIn"];
  quoteOut?: WalletTradeLedgerRecordInput["quoteOut"];
  confirmations?: number;
  nonce?: number | null;
  blockNumber?: number | null;
  gasUsed?: string | null;
  effectiveGasPriceWei?: string | null;
  reason?: string;
  explorerUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}): WalletTradeLedgerRecordInput {
  const side = overrides.side ?? "buy";
  return {
    hash: overrides.hash,
    source: overrides.source ?? "manual",
    side,
    tokenAddress: overrides.tokenAddress ?? TOKEN_A,
    slippageBps: overrides.slippageBps ?? 100,
    route: overrides.route ?? ["WBNB", "TKN"],
    quoteIn:
      overrides.quoteIn ?? (side === "buy" ? bnbLeg("1") : tokenLeg("10")),
    quoteOut:
      overrides.quoteOut ?? (side === "buy" ? tokenLeg("10") : bnbLeg("1.2")),
    status: overrides.status ?? "success",
    confirmations: overrides.confirmations ?? 12,
    nonce: overrides.nonce === undefined ? 1 : overrides.nonce,
    blockNumber:
      overrides.blockNumber === undefined ? 100 : overrides.blockNumber,
    gasUsed: overrides.gasUsed === undefined ? "21000" : overrides.gasUsed,
    effectiveGasPriceWei:
      overrides.effectiveGasPriceWei === undefined
        ? "5000000000"
        : overrides.effectiveGasPriceWei,
    ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
    explorerUrl:
      overrides.explorerUrl ?? `https://bscscan.com/tx/${overrides.hash}`,
    ...(overrides.createdAt !== undefined
      ? { createdAt: overrides.createdAt }
      : {}),
    ...(overrides.updatedAt !== undefined
      ? { updatedAt: overrides.updatedAt }
      : {}),
  };
}

function makeEntry(overrides: {
  hash: string;
  createdAt: string;
  side?: WalletTradeLedgerEntry["side"];
  source?: WalletTradeLedgerEntry["source"];
  status?: WalletTradeLedgerEntry["status"];
  tokenAddress?: string;
  quoteInAmount?: string;
  quoteOutAmount?: string;
  quoteInSymbol?: string;
  quoteOutSymbol?: string;
  reason?: string;
}): WalletTradeLedgerEntry {
  const side = overrides.side ?? "buy";
  const quoteInSymbol =
    overrides.quoteInSymbol ?? (side === "buy" ? "BNB" : "TKN");
  const quoteOutSymbol =
    overrides.quoteOutSymbol ?? (side === "buy" ? "TKN" : "BNB");
  const quoteInAmount =
    overrides.quoteInAmount ?? (side === "buy" ? "1" : "10");
  const quoteOutAmount =
    overrides.quoteOutAmount ?? (side === "buy" ? "10" : "1.2");
  return {
    hash: overrides.hash,
    createdAt: overrides.createdAt,
    updatedAt: overrides.createdAt,
    source: overrides.source ?? "manual",
    side,
    tokenAddress: overrides.tokenAddress ?? TOKEN_A,
    slippageBps: 100,
    route: ["WBNB", "TKN"],
    quoteIn: {
      symbol: quoteInSymbol,
      amount: quoteInAmount,
      amountWei: BNB_WEI,
    },
    quoteOut: {
      symbol: quoteOutSymbol,
      amount: quoteOutAmount,
      amountWei: TOKEN_WEI,
    },
    status: overrides.status ?? "success",
    confirmations: 1,
    nonce: 1,
    blockNumber: 1,
    gasUsed: "21000",
    effectiveGasPriceWei: "5000000000",
    ...(overrides.reason !== undefined ? { reason: overrides.reason } : {}),
    explorerUrl: `https://bscscan.com/tx/${overrides.hash}`,
  };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

describe("resolveWalletTradingProfileFilePath", () => {
  it("places the v1 ledger under stateDir/wallet/", () => {
    expect(resolveWalletTradingProfileFilePath("/tmp/eliza-state")).toBe(
      path.join("/tmp/eliza-state", "wallet", "trading-profile.v1.json"),
    );
  });
});

describe("readWalletTradeLedgerStore / writeWalletTradeLedgerStore", () => {
  it("returns an empty v1 store when the ledger file is missing", () => {
    const stateDir = makeStateDir();
    const store = readWalletTradeLedgerStore(stateDir);
    expect(store.version).toBe(1);
    expect(store.entries).toEqual([]);
    expect(Number.isFinite(Date.parse(store.updatedAt))).toBe(true);
  });

  it("round-trips a written store and sorts by createdAt then hash", () => {
    const stateDir = makeStateDir();
    const later = makeEntry({
      hash: "0xbbb",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    const earlier = makeEntry({
      hash: "0xaaa",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    const tiedLaterHash = makeEntry({
      hash: "0xccc",
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    const empty = readWalletTradeLedgerStore(stateDir);
    const written = writeWalletTradeLedgerStore(
      { ...empty, entries: [later, tiedLaterHash, earlier] },
      stateDir,
    );
    expect(written.entries.map((e) => e.hash)).toEqual([
      "0xaaa",
      "0xccc",
      "0xbbb",
    ]);
    const reread = readWalletTradeLedgerStore(stateDir);
    expect(reread.entries.map((e) => e.hash)).toEqual([
      "0xaaa",
      "0xccc",
      "0xbbb",
    ]);
  });

  it("drops the oldest entries when the ledger overflows 2000", () => {
    const stateDir = makeStateDir();
    const entries = Array.from({ length: 2001 }, (_, i) =>
      makeEntry({
        hash: `0x${i.toString(16).padStart(8, "0")}`,
        createdAt: new Date(Date.UTC(2020, 0, 1, 0, 0, i)).toISOString(),
      }),
    );
    const empty = readWalletTradeLedgerStore(stateDir);
    const written = writeWalletTradeLedgerStore(
      { ...empty, entries },
      stateDir,
    );
    expect(written.entries).toHaveLength(2000);
    expect(written.entries[0]?.hash).toBe(
      `0x${(1).toString(16).padStart(8, "0")}`,
    );
    expect(written.entries[1999]?.hash).toBe(
      `0x${(2000).toString(16).padStart(8, "0")}`,
    );
  });

  it("quarantines a corrupt ledger and returns an empty store", () => {
    const stateDir = makeStateDir();
    const filePath = resolveWalletTradingProfileFilePath(stateDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not-json", "utf-8");

    const store = readWalletTradeLedgerStore(stateDir);
    expect(store.entries).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
    const backups = fs
      .readdirSync(path.dirname(filePath))
      .filter((name) => name.startsWith("trading-profile.v1.json.corrupt-"));
    expect(backups).toHaveLength(1);
  });

  it("skips invalid entries and treats a non-array entries field as empty", () => {
    const stateDir = makeStateDir();
    const filePath = resolveWalletTradingProfileFilePath(stateDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-08-01T00:00:00.000Z",
        entries: [
          null,
          12,
          [],
          { hash: "", tokenAddress: TOKEN_A },
          {
            hash: "0xdead",
            tokenAddress: TOKEN_A,
            quoteIn: { symbol: "BNB", amount: "1" },
            quoteOut: tokenLeg("10"),
          },
          {
            hash: "  0xGOOD  ",
            createdAt: "2026-08-02T00:00:00.000Z",
            updatedAt: "2026-08-02T00:00:00.000Z",
            source: "AGENT",
            side: "SELL",
            tokenAddress: TOKEN_A.toUpperCase(),
            slippageBps: -3.2,
            route: ["WBNB", "", 99, "TKN"],
            quoteIn: tokenLeg("10"),
            quoteOut: bnbLeg("1.1"),
            status: "SUCCESS",
            confirmations: -2.7,
            nonce: -3.2,
            blockNumber: -9,
            gasUsed: "   ",
            effectiveGasPriceWei: "",
            explorerUrl: "  https://bscscan.com/tx/0xGOOD  ",
          },
        ],
      }),
      "utf-8",
    );

    const store = readWalletTradeLedgerStore(stateDir);
    expect(store.entries).toHaveLength(1);
    const entry = store.entries[0];
    expect(entry?.hash).toBe("0xGOOD");
    expect(entry?.source).toBe("agent");
    expect(entry?.side).toBe("sell");
    expect(entry?.tokenAddress).toBe(TOKEN_A);
    expect(entry?.status).toBe("success");
    expect(entry?.slippageBps).toBe(0);
    expect(entry?.confirmations).toBe(0);
    expect(entry?.nonce).toBe(0);
    expect(entry?.blockNumber).toBe(0);
    expect(entry?.gasUsed).toBeNull();
    expect(entry?.effectiveGasPriceWei).toBeNull();
    expect(entry?.route).toEqual(["WBNB", "TKN"]);
    expect(entry?.explorerUrl).toBe("https://bscscan.com/tx/0xGOOD");
  });

  it("treats a missing entries array as empty", () => {
    const stateDir = makeStateDir();
    const filePath = resolveWalletTradingProfileFilePath(stateDir);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, updatedAt: "not-a-date", entries: "nope" }),
      "utf-8",
    );
    const store = readWalletTradeLedgerStore(stateDir);
    expect(store.entries).toEqual([]);
    expect(Number.isFinite(Date.parse(store.updatedAt))).toBe(true);
  });
});

describe("recordWalletTradeLedgerEntry", () => {
  it("appends a new trade and upserts an existing hash", () => {
    const stateDir = makeStateDir();
    const first = recordWalletTradeLedgerEntry(
      makeInput({
        hash: " 0xabc ",
        createdAt: "2026-08-01T00:00:00.000Z",
        tokenAddress: ` ${TOKEN_A.toUpperCase()} `,
        status: "pending",
        source: "agent",
        side: "buy",
        nonce: 3.9,
        blockNumber: -4,
        gasUsed: "  ",
        explorerUrl: "   ",
        route: [" WBNB ", "", "TKN"],
      }),
      stateDir,
    );
    expect(first.hash).toBe("0xabc");
    expect(first.tokenAddress).toBe(TOKEN_A);
    expect(first.status).toBe("pending");
    expect(first.source).toBe("agent");
    expect(first.nonce).toBe(3);
    expect(first.blockNumber).toBe(0);
    expect(first.gasUsed).toBeNull();
    expect(first.explorerUrl).toBe("https://bscscan.com/tx/0xabc");
    expect(first.route).toEqual(["WBNB", "TKN"]);

    const updated = recordWalletTradeLedgerEntry(
      makeInput({
        hash: "0xabc",
        status: "success",
        createdAt: "2026-08-01T00:00:00.000Z",
        confirmations: 30,
      }),
      stateDir,
    );
    expect(updated.status).toBe("success");
    expect(updated.confirmations).toBe(30);

    const store = readWalletTradeLedgerStore(stateDir);
    expect(store.entries).toHaveLength(1);
    expect(store.entries[0]?.status).toBe("success");
  });

  it("defaults unknown source/side/status and omits a blank reason", () => {
    const stateDir = makeStateDir();
    const entry = recordWalletTradeLedgerEntry(
      makeInput({
        hash: "0xdef",
        source: "user" as WalletTradeLedgerRecordInput["source"],
        side: "swap" as WalletTradeLedgerRecordInput["side"],
        status: "mined" as WalletTradeLedgerRecordInput["status"],
        reason: "   ",
        slippageBps: -1.4,
      }),
      stateDir,
    );
    expect(entry.source).toBe("manual");
    expect(entry.side).toBe("buy");
    expect(entry.status).toBe("pending");
    expect(entry.reason).toBeUndefined();
    expect(entry.slippageBps).toBe(0);
  });
});

describe("updateWalletTradeLedgerEntryStatus", () => {
  it("returns null for a blank hash or a missing ledger item", () => {
    const stateDir = makeStateDir();
    recordWalletTradeLedgerEntry(makeInput({ hash: "0xpresent" }), stateDir);
    const patch: WalletTradeLedgerStatusPatch = {
      status: "success",
      confirmations: 1,
      nonce: 1,
      blockNumber: 1,
      gasUsed: "1",
      effectiveGasPriceWei: "1",
    };
    expect(
      updateWalletTradeLedgerEntryStatus("   ", patch, stateDir),
    ).toBeNull();
    expect(
      updateWalletTradeLedgerEntryStatus("0xmissing", patch, stateDir),
    ).toBeNull();
  });

  it("allows pending → success and refuses success → reverted", () => {
    const stateDir = makeStateDir();
    recordWalletTradeLedgerEntry(
      makeInput({
        hash: "0xflow",
        status: "pending",
        reason: "waiting",
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
      stateDir,
    );

    const succeeded = updateWalletTradeLedgerEntryStatus(
      "0xflow",
      {
        status: "success",
        confirmations: 8,
        nonce: null,
        blockNumber: 55,
        gasUsed: " 12345 ",
        effectiveGasPriceWei: " 9 ",
        explorerUrl: " https://bscscan.com/tx/0xflow ",
      },
      stateDir,
    );
    expect(succeeded?.status).toBe("success");
    expect(succeeded?.nonce).toBeNull();
    expect(succeeded?.blockNumber).toBe(55);
    expect(succeeded?.gasUsed).toBe("12345");
    expect(succeeded?.reason).toBeUndefined();
    expect(succeeded?.explorerUrl).toBe("https://bscscan.com/tx/0xflow");

    const refused = updateWalletTradeLedgerEntryStatus(
      "0xflow",
      {
        status: "reverted",
        confirmations: 99,
        nonce: 9,
        blockNumber: 9,
        gasUsed: "9",
        effectiveGasPriceWei: "9",
      },
      stateDir,
    );
    expect(refused?.status).toBe("success");
    expect(refused?.confirmations).toBe(8);
    const stored = readWalletTradeLedgerStore(stateDir).entries[0];
    expect(stored?.status).toBe("success");
    expect(stored?.confirmations).toBe(8);
  });

  it("allows not_found to recover and clears an empty reason string", () => {
    const stateDir = makeStateDir();
    recordWalletTradeLedgerEntry(
      makeInput({
        hash: "0xnf",
        status: "not_found",
        reason: "rpc miss",
      }),
      stateDir,
    );
    const recovered = updateWalletTradeLedgerEntryStatus(
      "0xnf",
      {
        status: "pending",
        confirmations: 0,
        nonce: 2,
        blockNumber: null,
        gasUsed: null,
        effectiveGasPriceWei: null,
        reason: "   ",
      },
      stateDir,
    );
    expect(recovered?.status).toBe("pending");
    expect(recovered?.reason).toBeUndefined();
    expect(recovered?.blockNumber).toBeNull();
  });

  it("keeps a reason when transitioning to reverted without a reason patch", () => {
    const stateDir = makeStateDir();
    recordWalletTradeLedgerEntry(
      makeInput({
        hash: "0xrev",
        status: "pending",
        reason: "mempool",
      }),
      stateDir,
    );
    const reverted = updateWalletTradeLedgerEntryStatus(
      "0xrev",
      {
        status: "reverted",
        confirmations: 1,
        nonce: 1,
        blockNumber: 1,
        gasUsed: "1",
        effectiveGasPriceWei: "1",
        reason: "slippage",
      },
      stateDir,
    );
    expect(reverted?.status).toBe("reverted");
    expect(reverted?.reason).toBe("slippage");

    const stillReverted = updateWalletTradeLedgerEntryStatus(
      "0xrev",
      {
        status: "success",
        confirmations: 2,
        nonce: 1,
        blockNumber: 1,
        gasUsed: "1",
        effectiveGasPriceWei: "1",
      },
      stateDir,
    );
    expect(stillReverted?.status).toBe("reverted");
    expect(stillReverted?.reason).toBe("slippage");
  });
});

describe("buildWalletTradingProfile", () => {
  it("returns zeroed summary, empty series, and empty recent swaps for an empty queue", () => {
    const profile = buildWalletTradingProfile([], {
      window: "all",
      source: "all",
    });
    expect(profile.window).toBe("all");
    expect(profile.source).toBe("all");
    expect(profile.summary).toEqual({
      totalSwaps: 0,
      buyCount: 0,
      sellCount: 0,
      settledCount: 0,
      successCount: 0,
      revertedCount: 0,
      tradeWinRate: null,
      txSuccessRate: null,
      winningTrades: 0,
      evaluatedTrades: 0,
      realizedPnlBnb: "0",
      volumeBnb: "0",
    });
    expect(profile.pnlSeries).toEqual([]);
    expect(profile.tokenBreakdown).toEqual([]);
    expect(profile.recentSwaps).toEqual([]);
  });

  it("handles a single successful buy without throwing", () => {
    const profile = buildWalletTradingProfile(
      [
        makeEntry({
          hash: "0xonly",
          createdAt: "2026-08-01T00:00:00.000Z",
        }),
      ],
      { window: "all", source: "all" },
    );
    expect(profile.summary.totalSwaps).toBe(1);
    expect(profile.summary.buyCount).toBe(1);
    expect(profile.summary.sellCount).toBe(0);
    expect(profile.summary.evaluatedTrades).toBe(0);
    expect(profile.summary.tradeWinRate).toBeNull();
    expect(profile.summary.volumeBnb).toBe("1");
    expect(profile.recentSwaps).toHaveLength(1);
    expect(profile.recentSwaps[0]?.tokenSymbol).toBe("TKN");
    expect(profile.tokenBreakdown[0]?.symbol).toBe("TKN");
  });

  it("defaults an unknown window to 30d and an unknown source to all", () => {
    const profile = buildWalletTradingProfile([], {
      window: "lifetime" as unknown as WalletTradingProfileWindow,
      source: "bots" as unknown as WalletTradingProfileSourceFilter,
    });
    expect(profile.window).toBe("30d");
    expect(profile.source).toBe("all");
  });

  it("filters by rolling window and source", () => {
    const entries = [
      makeEntry({
        hash: "0xold",
        createdAt: isoDaysAgo(40),
        source: "manual",
      }),
      makeEntry({
        hash: "0xweek-agent",
        createdAt: isoDaysAgo(3),
        source: "agent",
      }),
      makeEntry({
        hash: "0xtoday-manual",
        createdAt: isoDaysAgo(0.2),
        source: "manual",
      }),
    ];

    const last30 = buildWalletTradingProfile(entries, { window: "30d" });
    expect(last30.recentSwaps.map((s) => s.hash)).toEqual([
      "0xtoday-manual",
      "0xweek-agent",
    ]);

    const last24h = buildWalletTradingProfile(entries, { window: "24h" });
    expect(last24h.recentSwaps.map((s) => s.hash)).toEqual(["0xtoday-manual"]);

    const last7d = buildWalletTradingProfile(entries, { window: "7d" });
    expect(last7d.summary.totalSwaps).toBe(2);

    const agentOnly = buildWalletTradingProfile(entries, {
      window: "all",
      source: "agent",
    });
    expect(agentOnly.recentSwaps.map((s) => s.hash)).toEqual(["0xweek-agent"]);

    const all = buildWalletTradingProfile(entries, { window: "all" });
    expect(all.summary.totalSwaps).toBe(3);
  });

  it("excludes unparseable createdAt values from a bounded window", () => {
    const profile = buildWalletTradingProfile(
      [
        makeEntry({ hash: "0xbad", createdAt: "not-a-date" }),
        makeEntry({
          hash: "0xok",
          createdAt: isoDaysAgo(1),
        }),
      ],
      { window: "7d", source: "all" },
    );
    expect(profile.recentSwaps.map((s) => s.hash)).toEqual(["0xok"]);
  });

  it("realizes FIFO PnL across lots, including a leftover unmatched sell", () => {
    const entries = [
      makeEntry({
        hash: "0xbuy1",
        createdAt: "2026-08-01T00:00:00.000Z",
        side: "buy",
        quoteInAmount: "2",
        quoteOutAmount: "10",
      }),
      makeEntry({
        hash: "0xbuy2",
        createdAt: "2026-08-02T00:00:00.000Z",
        side: "buy",
        quoteInAmount: "6",
        quoteOutAmount: "10",
      }),
      makeEntry({
        hash: "0xsell-full",
        createdAt: "2026-08-03T00:00:00.000Z",
        side: "sell",
        quoteInAmount: "20",
        quoteOutAmount: "9",
        quoteInSymbol: "TKN",
        quoteOutSymbol: "BNB",
      }),
      makeEntry({
        hash: "0xsell-unmatched",
        createdAt: "2026-08-04T00:00:00.000Z",
        side: "sell",
        quoteInAmount: "5",
        quoteOutAmount: "1",
        quoteInSymbol: "TKN",
        quoteOutSymbol: "BNB",
      }),
    ];
    const profile = buildWalletTradingProfile(entries, { window: "all" });
    // First sell consumes both lots (cost 2+6=8, proceeds 9 → pnl 1).
    // Second sell has no remaining lots (cost 0, proceeds 1 → pnl 1).
    expect(profile.summary.realizedPnlBnb).toBe("2");
    expect(profile.summary.winningTrades).toBe(2);
    expect(profile.summary.evaluatedTrades).toBe(2);
    expect(profile.summary.tradeWinRate).toBe(100);
    expect(profile.summary.volumeBnb).toBe("18");
    expect(profile.pnlSeries.map((p) => p.day)).toEqual([
      "2026-08-01",
      "2026-08-02",
      "2026-08-03",
      "2026-08-04",
    ]);
  });

  it("does not count a break-even sell as a winning trade", () => {
    const profile = buildWalletTradingProfile(
      [
        makeEntry({
          hash: "0xbuy",
          createdAt: "2026-08-01T00:00:00.000Z",
          side: "buy",
          quoteInAmount: "1",
          quoteOutAmount: "10",
        }),
        makeEntry({
          hash: "0xsell",
          createdAt: "2026-08-02T00:00:00.000Z",
          side: "sell",
          quoteInAmount: "10",
          quoteOutAmount: "1",
          quoteInSymbol: "TKN",
          quoteOutSymbol: "BNB",
        }),
      ],
      { window: "all" },
    );
    expect(profile.summary.realizedPnlBnb).toBe("0");
    expect(profile.summary.winningTrades).toBe(0);
    expect(profile.summary.evaluatedTrades).toBe(1);
    expect(profile.summary.tradeWinRate).toBe(0);
  });

  it("ignores pending and reverted fills for PnL while still counting them", () => {
    const profile = buildWalletTradingProfile(
      [
        makeEntry({
          hash: "0xok",
          createdAt: "2026-08-01T00:00:00.000Z",
          status: "success",
        }),
        makeEntry({
          hash: "0xpend",
          createdAt: "2026-08-02T00:00:00.000Z",
          status: "pending",
        }),
        makeEntry({
          hash: "0xrev",
          createdAt: "2026-08-03T00:00:00.000Z",
          status: "reverted",
          reason: "slippage",
        }),
      ],
      { window: "all" },
    );
    expect(profile.summary.totalSwaps).toBe(3);
    expect(profile.summary.successCount).toBe(1);
    expect(profile.summary.revertedCount).toBe(1);
    expect(profile.summary.settledCount).toBe(2);
    expect(profile.summary.txSuccessRate).toBe(50);
    expect(profile.summary.volumeBnb).toBe("1");
    expect(profile.recentSwaps[0]?.reason).toBe("slippage");
  });

  it("skips dust-sized buys as lots and dust-sized sells as cost", () => {
    const profile = buildWalletTradingProfile(
      [
        makeEntry({
          hash: "0xdust-buy",
          createdAt: "2026-08-01T00:00:00.000Z",
          side: "buy",
          quoteInAmount: "1",
          quoteOutAmount: "1e-13",
        }),
        makeEntry({
          hash: "0xdust-sell",
          createdAt: "2026-08-02T00:00:00.000Z",
          side: "sell",
          quoteInAmount: "1e-13",
          quoteOutAmount: "2",
          quoteInSymbol: "TKN",
          quoteOutSymbol: "BNB",
        }),
      ],
      { window: "all" },
    );
    // Dust buy never queued a lot; dust sell matches cost 0; proceeds 2.
    expect(profile.summary.realizedPnlBnb).toBe("2");
    expect(profile.summary.evaluatedTrades).toBe(1);
  });

  it("sorts token breakdown by volume descending and caps recent swaps at 20 newest", () => {
    const entries: WalletTradeLedgerEntry[] = [];
    for (let i = 0; i < 21; i += 1) {
      entries.push(
        makeEntry({
          hash: `0x${(i + 1).toString(16).padStart(4, "0")}`,
          createdAt: new Date(Date.UTC(2026, 7, 1, 0, 0, i)).toISOString(),
          tokenAddress: i === 0 ? TOKEN_B : TOKEN_A,
          quoteInAmount: i === 0 ? "50" : "1",
        }),
      );
    }
    const profile = buildWalletTradingProfile(entries, { window: "all" });
    expect(profile.tokenBreakdown.map((t) => t.tokenAddress)).toEqual([
      TOKEN_B,
      TOKEN_A,
    ]);
    expect(profile.recentSwaps).toHaveLength(20);
    expect(profile.recentSwaps[0]?.hash).toBe(
      `0x${(21).toString(16).padStart(4, "0")}`,
    );
    expect(profile.recentSwaps[19]?.hash).toBe(
      `0x${(2).toString(16).padStart(4, "0")}`,
    );
  });

  it("falls back to TOKEN when the fill symbol is blank", () => {
    const profile = buildWalletTradingProfile(
      [
        makeEntry({
          hash: "0xnosym",
          createdAt: "2026-08-01T00:00:00.000Z",
          quoteOutSymbol: "",
        }),
      ],
      { window: "all" },
    );
    expect(profile.tokenBreakdown[0]?.symbol).toBe("TOKEN");
    expect(profile.recentSwaps[0]?.tokenSymbol).toBe("");
  });

  it("orders same-timestamp fills by hash when building the profile", () => {
    const profile = buildWalletTradingProfile(
      [
        makeEntry({ hash: "0xcc", createdAt: "2026-08-01T00:00:00.000Z" }),
        makeEntry({ hash: "0xaa", createdAt: "2026-08-01T00:00:00.000Z" }),
        makeEntry({ hash: "0xbb", createdAt: "2026-08-01T00:00:00.000Z" }),
      ],
      { window: "all" },
    );
    // FIFO walk uses createdAt then hash; recent swaps are newest-first and
    // tied timestamps stay in that processed order after the reverse-time sort.
    expect(profile.pnlSeries[0]?.swaps).toBe(3);
    expect(profile.summary.totalSwaps).toBe(3);
  });
});

describe("loadWalletTradingProfile", () => {
  it("reads the on-disk ledger through the same builder", () => {
    const stateDir = makeStateDir();
    recordWalletTradeLedgerEntry(
      makeInput({
        hash: "0xload",
        createdAt: "2026-08-01T00:00:00.000Z",
        source: "agent",
      }),
      stateDir,
    );
    const profile = loadWalletTradingProfile({
      stateDir,
      window: "all",
      source: "agent",
    });
    expect(profile.summary.totalSwaps).toBe(1);
    expect(profile.recentSwaps[0]?.hash).toBe("0xload");
    expect(profile.source).toBe("agent");
  });
});
