import {
  type AlertEvent,
  type ConnectionId,
  ConnectionVault,
  isConnectionId,
  publicText,
} from "./connection-vault.ts";
import type { AgentEngine } from "./engine.ts";
import { binanceBalances, pnlCsv, searchX } from "./outside-read.ts";
import { fetchTokenPrice, priceOrder } from "./price-feed.ts";
import { extraSafetyGate, safetyScore } from "./safety-score.ts";

const vaults = new Map<string, ConnectionVault>();

export function vaultFor(dataDir: string): ConnectionVault {
  const existing = vaults.get(dataDir);
  if (existing) return existing;
  const created = new ConnectionVault(dataDir);
  vaults.set(dataDir, created);
  return created;
}

export function connectionView(engine: AgentEngine): ReturnType<ConnectionVault["status"]> {
  return vaultFor(engine.dataDir).status();
}

export async function connectLink(
  engine: AgentEngine,
  id: string,
  secret: string,
  password: string
): Promise<{ ok: boolean; message: string }> {
  if (!isConnectionId(id)) return { ok: false, message: "Unknown connection." };
  await vaultFor(engine.dataDir).connect(id, secret, password);
  return { ok: true, message: "Connected. The key is encrypted on this PC." };
}

export async function disconnectLink(
  engine: AgentEngine,
  id: string
): Promise<{ ok: boolean; message: string }> {
  if (!isConnectionId(id)) return { ok: false, message: "Unknown connection." };
  await vaultFor(engine.dataDir).disconnect(id);
  return { ok: true, message: "Disconnected." };
}

export async function testLink(
  engine: AgentEngine,
  id: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; message: string }> {
  if (!isConnectionId(id)) return { ok: false, message: "Unknown connection." };
  const vault = vaultFor(engine.dataDir);
  try {
    const message = await runTest(vault, id, fetchImpl);
    vault.mark(id, true, message);
    return { ok: true, message: publicText(message) };
  } catch (err) {
    const message = publicText(err instanceof Error ? err.message : "Test failed.");
    vault.mark(id, false, message);
    return { ok: false, message };
  }
}

async function runTest(
  vault: ConnectionVault,
  id: ConnectionId,
  fetchImpl: typeof fetch
): Promise<string> {
  const secret = vault.secret(id);
  if (!secret && id !== "dexscreener" && id !== "rugcheck")
    throw new Error("Connect it on this PC first.");
  if (id === "dexscreener") return "DexScreener needs no key.";
  if (id === "birdeye" || id === "helius") {
    const order = priceOrder(id === "birdeye", id === "helius");
    const hit = await fetchTokenPrice(
      "So11111111111111111111111111111111111111112",
      order,
      {
        birdeye: id === "birdeye" ? (secret ?? "") : "",
        helius: id === "helius" ? (secret ?? "") : "",
      },
      fetchImpl
    );
    return hit.price
      ? `Price feed answered from ${hit.source}.`
      : "The price feed did not return a price.";
  }
  if (id === "x") {
    const found = await searchX(secret ?? "", "$SOL", fetchImpl);
    return `X search is read-only. ${found.tags.length} tags, ${found.mints.length} mints.`;
  }
  if (id === "telegram" || id === "discord")
    return "Alert channel is saved. Sends stay read-only notices.";
  if (id === "rugcheck") return "RugCheck is an extra read-only gate.";
  if (id === "sheets") return "Sheets export is ready. It only appends rows.";
  if (id === "binance") {
    const parsed = JSON.parse(secret ?? "{}") as { key?: string; secret?: string };
    const result = await binanceBalances(parsed.key ?? "", parsed.secret ?? "", fetchImpl);
    if (!result.ok) throw new Error(result.message);
    return result.message;
  }
  if (id === "coinbase" || id === "kraken") {
    return "Exchange read is limited to balances. This app does not place orders or withdrawals.";
  }
  return "Saved.";
}

export function setAlertToggles(
  engine: AgentEngine,
  input: Partial<Record<AlertEvent, boolean>>
): Record<AlertEvent, boolean> {
  const vault = vaultFor(engine.dataDir);
  for (const key of ["buy", "sell", "freeze", "stall", "pnl"] as const) {
    if (typeof input[key] === "boolean") vault.toggles[key] = input[key];
  }
  return vault.toggles;
}

export function safetyFor(report: Parameters<typeof safetyScore>[0]): {
  score: number;
  gate: ReturnType<typeof extraSafetyGate>;
} {
  return { score: safetyScore(report).score, gate: extraSafetyGate(report) };
}

export function csvFor(engine: AgentEngine): string {
  const rows = engine.book.closed.map((leg) => ({
    t: new Date(leg.closedAt).toISOString(),
    symbol: leg.mint.slice(0, 4),
    pnlSol: Number((leg.exitSol - leg.costSol).toFixed(6)),
  }));
  return pnlCsv(rows);
}
