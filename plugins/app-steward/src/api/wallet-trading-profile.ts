import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "@elizaos/agent";
import type {
  BscTradeSide,
  BscTradeTxStatus,
  WalletTradeLedgerEntry,
  WalletTradeLedgerQuoteLeg,
  WalletTradeLedgerRecordInput,
  WalletTradeSource,
  WalletTradingProfileRecentSwap,
  WalletTradingProfileResponse,
  WalletTradingProfileSourceFilter,
  WalletTradingProfileTokenBreakdown,
  WalletTradingProfileWindow,
} from "@elizaos/shared";

const WALLET_PROFILE_LEDGER_VERSION = 1;
const MAX_WALLET_PROFILE_LEDGER_ENTRIES = 2000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const FLOAT_EPSILON = 1e-12;

interface WalletTradeLedgerStore {
  version: 1;
  updatedAt: string;
  entries: WalletTradeLedgerEntry[];
}

export type { WalletTradeLedgerRecordInput };

export interface WalletTradeLedgerStatusPatch {
  status: BscTradeTxStatus;
  confirmations: number;
  nonce: number | null;
  blockNumber: number | null;
  gasUsed: string | null;
  effectiveGasPriceWei: string | null;
  reason?: string;
  explorerUrl?: string;
  updatedAt?: string;
}

export interface WalletTradingProfileOptions {
  window?: WalletTradingProfileWindow;
  source?: WalletTradingProfileSourceFilter;
  stateDir?: string;
}

interface TokenLot {
  qty: number;
  costBnb: number;
}

interface TokenAccumulator {
  tokenAddress: string;
  symbol: string;
  buyCount: number;
  sellCount: number;
  realizedPnlBnb: number;
  volumeBnb: number;
  winningTrades: number;
  evaluatedTrades: number;
  lots: TokenLot[];
}

interface SeriesAccumulator {
  day: string;
  realizedPnlBnb: number;
  volumeBnb: number;
  swaps: number;
}

const TRADE_STATUS_SET = new Set<BscTradeTxStatus>([
  "pending",
  "success",
  "reverted",
  "not_found",
]);

const ALLOWED_STATUS_TRANSITIONS: Record<
  BscTradeTxStatus,
  Set<BscTradeTxStatus>
> = {
  pending: new Set(["pending", "success", "reverted", "not_found"]),
  not_found: new Set(["pending", "success", "reverted", "not_found"]),
  success: new Set(["success"]),
  reverted: new Set(["reverted"]),
};

const TRADE_SIDE_SET = new Set<BscTradeSide>(["buy", "sell"]);

function nowIso(): string {
  return new Date().toISOString();
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function toBnbString(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < FLOAT_EPSILON) return "0";
  const fixed = value.toFixed(8).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed;
}

function toRatePercent(numerator: number, denominator: number): number | null {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  if (!Number.isFinite(numerator) || numerator <= 0) return 0;
  return (numerator / denominator) * 100;
}

function normalizeStatus(value: unknown): BscTradeTxStatus {
  if (typeof value !== "string") return "pending";
  const normalized = value.trim().toLowerCase() as BscTradeTxStatus;
  if (!TRADE_STATUS_SET.has(normalized)) return "pending";
  return normalized;
}

function canTransitionTradeStatus(
  current: BscTradeTxStatus,
  next: BscTradeTxStatus,
): boolean {
  return ALLOWED_STATUS_TRANSITIONS[current].has(next);
}

function normalizeSide(value: unknown): BscTradeSide {
  if (typeof value !== "string") return "buy";
  const normalized = value.trim().toLowerCase() as BscTradeSide;
  if (!TRADE_SIDE_SET.has(normalized)) return "buy";
  return normalized;
}

function normalizeSource(value: unknown): WalletTradeSource {
  if (typeof value !== "string") return "manual";
  return value.trim().toLowerCase() === "agent" ? "agent" : "manual";
}

function normalizeIsoDate(value: unknown): string {
  if (typeof value !== "string") return nowIso();
  const trimmed = value.trim();
  if (!trimmed) return nowIso();
  const timestamp = Date.parse(trimmed);
  if (!Number.isFinite(timestamp)) return nowIso();
  return new Date(timestamp).toISOString();
}

function normalizeNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = toFiniteNumber(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor(parsed);
}

function normalizeAddress(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase();
}

function normalizeLeg(value: unknown): WalletTradeLedgerQuoteLeg | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const symbol = typeof record.symbol === "string" ? record.symbol.trim() : "";
  const amount =
    typeof record.amount === "string"
      ? record.amount.trim()
      : toFiniteNumber(record.amount).toString();
  const amountWei =
    typeof record.amountWei === "string" ? record.amountWei.trim() : "";
  if (!symbol || !amount || !amountWei) return null;
  return { symbol, amount, amountWei };
}

function normalizeLedgerEntry(value: unknown): WalletTradeLedgerEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const hash = typeof record.hash === "string" ? record.hash.trim() : "";
  const tokenAddress = normalizeAddress(record.tokenAddress);
  const quoteIn = normalizeLeg(record.quoteIn);
  const quoteOut = normalizeLeg(record.quoteOut);
  if (!hash || !tokenAddress || !quoteIn || !quoteOut) return null;

  const routeRaw = Array.isArray(record.route) ? record.route : [];
  const route = routeRaw
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);

  const explorerUrl =
    typeof record.explorerUrl === "string"
      ? record.explorerUrl.trim()
      : `https://bscscan.com/tx/${hash}`;

  return {
    hash,
    createdAt: normalizeIsoDate(record.createdAt),
    updatedAt: normalizeIsoDate(record.updatedAt),
    source: normalizeSource(record.source),
    side: normalizeSide(record.side),
    tokenAddress,
    slippageBps: Math.max(0, Math.round(toFiniteNumber(record.slippageBps))),
    route,
    quoteIn,
    quoteOut,
    status: normalizeStatus(record.status),
    confirmations: Math.max(
      0,
      Math.floor(toFiniteNumber(record.confirmations)),
    ),
    nonce: (() => {
      const nonce = normalizeNullableInteger(record.nonce);
      return nonce === null ? null : Math.max(0, nonce);
    })(),
    blockNumber: (() => {
      const blockNumber = normalizeNullableInteger(record.blockNumber);
      return blockNumber === null ? null : Math.max(0, blockNumber);
    })(),
    gasUsed:
      typeof record.gasUsed === "string" && record.gasUsed.trim()
        ? record.gasUsed.trim()
        : null,
    effectiveGasPriceWei:
      typeof record.effectiveGasPriceWei === "string" &&
      record.effectiveGasPriceWei.trim()
        ? record.effectiveGasPriceWei.trim()
        : null,
    ...(typeof record.reason === "string" && record.reason.trim()
      ? { reason: record.reason.trim() }
      : {}),
    explorerUrl,
  };
}

function sortAndTrimEntries(
  entries: WalletTradeLedgerEntry[],
): WalletTradeLedgerEntry[] {
  const sorted = [...entries].sort((a, b) => {
    const aMs = Date.parse(a.createdAt);
    const bMs = Date.parse(b.createdAt);
    if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
      return aMs - bMs;
    }
    return a.hash.localeCompare(b.hash);
  });
  if (sorted.length <= MAX_WALLET_PROFILE_LEDGER_ENTRIES) return sorted;
  return sorted.slice(sorted.length - MAX_WALLET_PROFILE_LEDGER_ENTRIES);
}

function ensureLedgerDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

function atomicWriteLedger(
  filePath: string,
  store: WalletTradeLedgerStore,
): void {
  ensureLedgerDir(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), {
      encoding: "utf-8",
      mode: 0o600,
    });
    fs.renameSync(tmpPath, filePath);
  } finally {
    if (fs.existsSync(tmpPath)) {
      fs.rmSync(tmpPath, { force: true });
    }
  }
}

function defaultLedgerStore(): WalletTradeLedgerStore {
  return {
    version: WALLET_PROFILE_LEDGER_VERSION,
    updatedAt: nowIso(),
    entries: [],
  };
}

export function resolveWalletTradingProfileFilePath(
  stateDir: string = resolveStateDir(),
): string {
  return path.join(stateDir, "wallet", "trading-profile.v1.json");
}

export function readWalletTradeLedgerStore(
  stateDir: string = resolveStateDir(),
): WalletTradeLedgerStore {
  const filePath = resolveWalletTradingProfileFilePath(stateDir);
  if (!fs.existsSync(filePath)) return defaultLedgerStore();

  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const rawEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
    const entries = rawEntries
      .map((item) => normalizeLedgerEntry(item))
      .filter((item): item is WalletTradeLedgerEntry => item !== null);
    return {
      version: WALLET_PROFILE_LEDGER_VERSION,
      updatedAt: normalizeIsoDate(parsed.updatedAt),
      entries: sortAndTrimEntries(entries),
    };
  } catch {
    try {
      const corruptPath = `${filePath}.corrupt-${Date.now()}.json`;
      fs.renameSync(filePath, corruptPath);
    } catch {
      // Best effort backup; continue with empty store.
    }
    return defaultLedgerStore();
  }
}

export function writeWalletTradeLedgerStore(
  store: WalletTradeLedgerStore,
  stateDir: string = resolveStateDir(),
): WalletTradeLedgerStore {
  const filePath = resolveWalletTradingProfileFilePath(stateDir);
  const normalized: WalletTradeLedgerStore = {
    version: WALLET_PROFILE_LEDGER_VERSION,
    updatedAt: nowIso(),
    entries: sortAndTrimEntries(store.entries),
  };
  atomicWriteLedger(filePath, normalized);
  return normalized;
}

export function recordWalletTradeLedgerEntry(
  input: WalletTradeLedgerRecordInput,
  stateDir: string = resolveStateDir(),
): WalletTradeLedgerEntry {
  const store = readWalletTradeLedgerStore(stateDir);
  const entry: WalletTradeLedgerEntry = {
    hash: input.hash.trim(),
    createdAt: normalizeIsoDate(input.createdAt ?? nowIso()),
    updatedAt: normalizeIsoDate(input.updatedAt ?? nowIso()),
    source: normalizeSource(input.source),
    side: normalizeSide(input.side),
    tokenAddress: normalizeAddress(input.tokenAddress),
    slippageBps: Math.max(0, Math.round(toFiniteNumber(input.slippageBps))),
    route: (input.route ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    quoteIn: {
      symbol: input.quoteIn.symbol.trim(),
      amount: input.quoteIn.amount.trim(),
      amountWei: input.quoteIn.amountWei.trim(),
    },
    quoteOut: {
      symbol: input.quoteOut.symbol.trim(),
      amount: input.quoteOut.amount.trim(),
      amountWei: input.quoteOut.amountWei.trim(),
    },
    status: normalizeStatus(input.status),
    confirmations: Math.max(0, Math.floor(toFiniteNumber(input.confirmations))),
    nonce:
      input.nonce === null ? null : Math.floor(toFiniteNumber(input.nonce)),
    blockNumber:
      input.blockNumber === null
        ? null
        : Math.max(0, Math.floor(toFiniteNumber(input.blockNumber))),
    gasUsed: input.gasUsed?.trim() || null,
    effectiveGasPriceWei: input.effectiveGasPriceWei?.trim() || null,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
    explorerUrl:
      input.explorerUrl.trim() || `https://bscscan.com/tx/${input.hash.trim()}`,
  };

  const existingIndex = store.entries.findIndex(
    (item) => item.hash === entry.hash,
  );
  if (existingIndex >= 0) {
    store.entries[existingIndex] = entry;
  } else {
    store.entries.push(entry);
  }
  writeWalletTradeLedgerStore(store, stateDir);
  return entry;
}

export function updateWalletTradeLedgerEntryStatus(
  hash: string,
  patch: WalletTradeLedgerStatusPatch,
  stateDir: string = resolveStateDir(),
): WalletTradeLedgerEntry | null {
  const normalizedHash = hash.trim();
  if (!normalizedHash) return null;

  const store = readWalletTradeLedgerStore(stateDir);
  const index = store.entries.findIndex(
    (entry) => entry.hash === normalizedHash,
  );
  if (index < 0) return null;

  const current = store.entries[index];
  const nextStatus = normalizeStatus(patch.status);
  if (!canTransitionTradeStatus(current.status, nextStatus)) {
    return current;
  }
  const updated: WalletTradeLedgerEntry = {
    ...current,
    status: nextStatus,
    confirmations: Math.max(0, Math.floor(toFiniteNumber(patch.confirmations))),
    nonce:
      patch.nonce === null ? null : Math.floor(toFiniteNumber(patch.nonce)),
    blockNumber:
      patch.blockNumber === null
        ? null
        : Math.max(0, Math.floor(toFiniteNumber(patch.blockNumber))),
    gasUsed: patch.gasUsed?.trim() || null,
    effectiveGasPriceWei: patch.effectiveGasPriceWei?.trim() || null,
    ...(patch.explorerUrl?.trim()
      ? { explorerUrl: patch.explorerUrl.trim() }
      : {}),
    updatedAt: normalizeIsoDate(patch.updatedAt ?? nowIso()),
  };
  if (typeof patch.reason === "string") {
    const reason = patch.reason.trim();
    if (reason) {
      updated.reason = reason;
    } else {
      delete updated.reason;
    }
  } else if (updated.status === "success" || updated.status === "pending") {
    delete updated.reason;
  }
  store.entries[index] = updated;
  writeWalletTradeLedgerStore(store, stateDir);
  return updated;
}

function resolveWindow(
  window: WalletTradingProfileWindow | undefined,
): WalletTradingProfileWindow {
  if (window === "7d" || window === "30d" || window === "all") return window;
  return "30d";
}

function resolveSource(
  source: WalletTradingProfileSourceFilter | undefined,
): WalletTradingProfileSourceFilter {
  if (source === "all" || source === "agent" || source === "manual")
    return source;
  return "all";
}

function resolveTokenSymbol(entry: WalletTradeLedgerEntry): string {
  return entry.side === "buy" ? entry.quoteOut.symbol : entry.quoteIn.symbol;
}

function toDayBucket(isoDate: string): string {
  const timestamp = Date.parse(isoDate);
  if (!Number.isFinite(timestamp)) return new Date().toISOString().slice(0, 10);
  return new Date(timestamp).toISOString().slice(0, 10);
}

function consumeLots(lots: TokenLot[], qtyToSell: number): number {
  if (!Number.isFinite(qtyToSell) || qtyToSell <= FLOAT_EPSILON) return 0;
  let remaining = qtyToSell;
  let matchedCost = 0;

  while (remaining > FLOAT_EPSILON && lots.length > 0) {
    const lot = lots[0];
    if (lot.qty <= FLOAT_EPSILON) {
      lots.shift();
      continue;
    }
    const take = Math.min(remaining, lot.qty);
    const ratio = take / lot.qty;
    const consumedCost = lot.costBnb * ratio;
    matchedCost += consumedCost;
    lot.qty -= take;
    lot.costBnb -= consumedCost;
    remaining -= take;

    if (lot.qty <= FLOAT_EPSILON || lot.costBnb <= FLOAT_EPSILON) {
      lots.shift();
    }
  }
  return matchedCost;
}

function toRecentSwap(
  entry: WalletTradeLedgerEntry,
): WalletTradingProfileRecentSwap {
  return {
    hash: entry.hash,
    createdAt: entry.createdAt,
    source: entry.source,
    side: entry.side,
    status: entry.status,
    tokenAddress: entry.tokenAddress,
    tokenSymbol: resolveTokenSymbol(entry),
    inputAmount: entry.quoteIn.amount,
    inputSymbol: entry.quoteIn.symbol,
    outputAmount: entry.quoteOut.amount,
    outputSymbol: entry.quoteOut.symbol,
    explorerUrl: entry.explorerUrl || `https://bscscan.com/tx/${entry.hash}`,
    confirmations: entry.confirmations,
    ...(entry.reason ? { reason: entry.reason } : {}),
  };
}

export function buildWalletTradingProfile(
  entries: WalletTradeLedgerEntry[],
  options: Pick<WalletTradingProfileOptions, "window" | "source"> = {},
): WalletTradingProfileResponse {
  const window = resolveWindow(options.window);
  const source = resolveSource(options.source);
  const now = Date.now();
  const cutoffMs =
    window === "7d"
      ? now - 7 * ONE_DAY_MS
      : window === "30d"
        ? now - 30 * ONE_DAY_MS
        : 0;

  const filtered = entries
    .filter((entry) => {
      if (source !== "all" && entry.source !== source) return false;
      if (cutoffMs > 0) {
        const createdAtMs = Date.parse(entry.createdAt);
        if (!Number.isFinite(createdAtMs) || createdAtMs < cutoffMs)
          return false;
      }
      return true;
    })
    .sort((a, b) => {
      const aMs = Date.parse(a.createdAt);
      const bMs = Date.parse(b.createdAt);
      if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
        return aMs - bMs;
      }
      return a.hash.localeCompare(b.hash);
    });

  let buyCount = 0;
  let sellCount = 0;
  let successCount = 0;
  let revertedCount = 0;
  let settledCount = 0;
  let winningTrades = 0;
  let evaluatedTrades = 0;
  let realizedPnlBnb = 0;
  let volumeBnb = 0;

  const tokenMap = new Map<string, TokenAccumulator>();
  const seriesMap = new Map<string, SeriesAccumulator>();

  for (const entry of filtered) {
    if (entry.side === "buy") buyCount += 1;
    else sellCount += 1;

    if (entry.status === "success") successCount += 1;
    if (entry.status === "reverted") revertedCount += 1;
    if (entry.status === "success" || entry.status === "reverted")
      settledCount += 1;

    if (entry.status !== "success") continue;

    const tokenAddress = entry.tokenAddress;
    const tokenSymbol = resolveTokenSymbol(entry);
    let token = tokenMap.get(tokenAddress);
    if (!token) {
      token = {
        tokenAddress,
        symbol: tokenSymbol,
        buyCount: 0,
        sellCount: 0,
        realizedPnlBnb: 0,
        volumeBnb: 0,
        winningTrades: 0,
        evaluatedTrades: 0,
        lots: [],
      };
      tokenMap.set(tokenAddress, token);
    } else if (!token.symbol && tokenSymbol) {
      token.symbol = tokenSymbol;
    }

    const day = toDayBucket(entry.createdAt);
    let series = seriesMap.get(day);
    if (!series) {
      series = {
        day,
        realizedPnlBnb: 0,
        volumeBnb: 0,
        swaps: 0,
      };
      seriesMap.set(day, series);
    }

    if (entry.side === "buy") {
      const qtyBought = toFiniteNumber(entry.quoteOut.amount);
      const spendBnb = toFiniteNumber(entry.quoteIn.amount);
      token.buyCount += 1;
      token.volumeBnb += spendBnb;
      if (qtyBought > FLOAT_EPSILON && spendBnb >= 0) {
        token.lots.push({ qty: qtyBought, costBnb: spendBnb });
      }
      volumeBnb += spendBnb;
      series.volumeBnb += spendBnb;
      series.swaps += 1;
      continue;
    }

    const qtySold = toFiniteNumber(entry.quoteIn.amount);
    const proceedsBnb = toFiniteNumber(entry.quoteOut.amount);
    const matchedCostBnb = consumeLots(token.lots, qtySold);
    const tradePnlBnb = proceedsBnb - matchedCostBnb;

    token.sellCount += 1;
    token.volumeBnb += proceedsBnb;
    token.realizedPnlBnb += tradePnlBnb;
    token.evaluatedTrades += 1;
    if (tradePnlBnb > 0) token.winningTrades += 1;

    evaluatedTrades += 1;
    if (tradePnlBnb > 0) winningTrades += 1;
    realizedPnlBnb += tradePnlBnb;
    volumeBnb += proceedsBnb;

    series.realizedPnlBnb += tradePnlBnb;
    series.volumeBnb += proceedsBnb;
    series.swaps += 1;
  }

  const tokenBreakdown: WalletTradingProfileTokenBreakdown[] = [
    ...tokenMap.values(),
  ]
    .map((token) => ({
      tokenAddress: token.tokenAddress,
      symbol: token.symbol || "TOKEN",
      buyCount: token.buyCount,
      sellCount: token.sellCount,
      realizedPnlBnb: toBnbString(token.realizedPnlBnb),
      volumeBnb: toBnbString(token.volumeBnb),
      tradeWinRate: toRatePercent(token.winningTrades, token.evaluatedTrades),
      winningTrades: token.winningTrades,
      evaluatedTrades: token.evaluatedTrades,
    }))
    .sort(
      (a, b) => Number.parseFloat(b.volumeBnb) - Number.parseFloat(a.volumeBnb),
    );

  const pnlSeries = [...seriesMap.values()]
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((point) => ({
      day: point.day,
      realizedPnlBnb: toBnbString(point.realizedPnlBnb),
      volumeBnb: toBnbString(point.volumeBnb),
      swaps: point.swaps,
    }));

  const recentSwaps = [...filtered]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 20)
    .map(toRecentSwap);

  return {
    window,
    source,
    generatedAt: nowIso(),
    summary: {
      totalSwaps: filtered.length,
      buyCount,
      sellCount,
      settledCount,
      successCount,
      revertedCount,
      tradeWinRate: toRatePercent(winningTrades, evaluatedTrades),
      txSuccessRate: toRatePercent(successCount, settledCount),
      winningTrades,
      evaluatedTrades,
      realizedPnlBnb: toBnbString(realizedPnlBnb),
      volumeBnb: toBnbString(volumeBnb),
    },
    pnlSeries,
    tokenBreakdown,
    recentSwaps,
  };
}

export function loadWalletTradingProfile(
  options: WalletTradingProfileOptions = {},
): WalletTradingProfileResponse {
  const store = readWalletTradeLedgerStore(options.stateDir);
  return buildWalletTradingProfile(store.entries, options);
}
