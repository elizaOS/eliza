import type { GooPaperAgent, GooPaperSummary } from "./goo-paper-engine";
import type { DashboardSnapshot } from "./types";

export interface GmgnSignalSnapshot {
  scannedAt: string;
  signals: Array<{
    tokenAddress: string;
    tokenSymbol: string;
    holderCount: number;
    holderDelta: number;
    holderDeltaPct: number;
    kolCount: number;
    topHolderDumpPct: number;
    severity: "critical" | "warning" | "ok";
    reasons: string[];
  }>;
  totalScanned: number;
  critical: number;
  warning: number;
}

let latestSnapshot: DashboardSnapshot | null = null;
let paperAgents: GooPaperAgent[] = [];
let paperSummary: GooPaperSummary | null = null;
let gmgnSignals: GmgnSignalSnapshot | null = null;

export function setLatestSnapshot(snapshot: DashboardSnapshot): void {
  latestSnapshot = snapshot;
}

export function getLatestSnapshot(): DashboardSnapshot | null {
  return latestSnapshot;
}

export function setPaperAgents(agents: GooPaperAgent[]): void {
  paperAgents = agents;
}

export function getPaperAgents(): GooPaperAgent[] {
  return paperAgents;
}

export function setPaperSummary(summary: GooPaperSummary): void {
  paperSummary = summary;
}

export function getPaperSummary(): GooPaperSummary | null {
  return paperSummary;
}

export function setGmgnSignals(s: GmgnSignalSnapshot): void {
  gmgnSignals = s;
}

export function getGmgnSignals(): GmgnSignalSnapshot | null {
  return gmgnSignals;
}

/* ─── Live Notifications ─────────────────────────────────────────── */

export interface LiveNotification {
  id: string;
  timestamp: string;
  type: "trade_buy" | "trade_sell" | "smart_exit" | "acquisition" | "respawn" | "trailing_stop" | "kol_exit";
  severity: "info" | "warning" | "critical" | "success";
  title: string;
  detail: string;
}

const MAX_NOTIFICATIONS = 50;
let notifications: LiveNotification[] = [];
let notificationSeq = 0;

export function pushNotification(n: Omit<LiveNotification, "id" | "timestamp">): void {
  notifications.unshift({
    ...n,
    id: `n-${++notificationSeq}`,
    timestamp: new Date().toISOString(),
  });
  if (notifications.length > MAX_NOTIFICATIONS) notifications = notifications.slice(0, MAX_NOTIFICATIONS);
}

export function getNotifications(since?: string): LiveNotification[] {
  if (!since) return notifications;
  return notifications.filter(n => n.timestamp > since);
}

export function getNotificationSeq(): number {
  return notificationSeq;
}

/* ─── BNB Price (Binance, cached 60 s) ──────────────────────────── */

let cachedBnbPrice = 600;
let bnbPriceFetchedAt = 0;
const BNB_CACHE_MS = 60_000;

export async function getBnbPriceUsd(): Promise<number> {
  if (Date.now() - bnbPriceFetchedAt < BNB_CACHE_MS) return cachedBnbPrice;
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT");
    if (res.ok) {
      const data = (await res.json()) as { price: string };
      const price = parseFloat(data.price);
      if (price > 0) {
        cachedBnbPrice = price;
        bnbPriceFetchedAt = Date.now();
      }
    }
  } catch {
    // keep last known price on network error
  }
  return cachedBnbPrice;
}
