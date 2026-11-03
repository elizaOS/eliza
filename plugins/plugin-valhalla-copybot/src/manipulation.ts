import { LIMITS, type Limits } from "./limits.ts";

export interface HolderRow {
  address?: string | null;
  owner?: string | null;
  pubkey?: string | null;
  pct?: number | null;
  percentage?: number | null;
}

export interface ParsedEarlyTx {
  signature: string;
  slot: number | null;
  err?: boolean;
  feePayer?: string | null;
  increases: Array<{ owner: string; before: number; after: number }>;
}

export interface EarlyScanResult {
  ok: boolean;
  reason: string | null;
  ran: boolean;
  detail?: Record<string, number | null>;
}

function pctOf(holder: HolderRow): number {
  let pct = Number(holder.pct ?? holder.percentage ?? 0);
  if (pct > 1.5) pct = pct / 100;
  return pct;
}

function holderAddr(holder: HolderRow): string | null {
  return holder.address || holder.owner || holder.pubkey || null;
}

/**
 * Bundle and sniper check from already-fetched early transactions.
 * Missing usable data fails closed.
 */
export function judgeEarlyBuyers(
  input: {
    txs: ParsedEarlyTx[];
    topHolders?: HolderRow[];
    failClosed?: boolean;
  },
  limits: Limits = LIMITS
): EarlyScanResult {
  const failClosed = input.failClosed !== false && limits.manipFailClosed;
  const txs = input.txs.filter((tx) => tx.slot != null && !tx.err);
  if (txs.length === 0) {
    if (failClosed)
      return { ok: false, reason: "manip scan fail — no early signatures", ran: true };
    return { ok: true, reason: null, ran: false };
  }
  const ordered = [...txs].sort((a, b) => Number(a.slot) - Number(b.slot));
  const firstSlot = ordered[0]?.slot;
  if (firstSlot == null) {
    if (failClosed) return { ok: false, reason: "manip scan fail — missing slot", ran: true };
    return { ok: true, reason: null, ran: false };
  }
  const earlyBuyers = new Map<string, { slots: Set<number>; funders: Set<string> }>();
  const slotBuyers = new Map<number, Set<string>>();
  let parsed = 0;
  for (const tx of ordered.slice(0, 25)) {
    if (tx.slot == null) continue;
    if (tx.slot > firstSlot + limits.manipEarlySlots + 2 && parsed >= 8) break;
    parsed += 1;
    for (const inc of tx.increases) {
      if (!(inc.after > inc.before) || !inc.owner) continue;
      const row = earlyBuyers.get(inc.owner) ?? {
        slots: new Set<number>(),
        funders: new Set<string>(),
      };
      row.slots.add(tx.slot);
      if (tx.feePayer && tx.feePayer !== inc.owner) row.funders.add(tx.feePayer);
      earlyBuyers.set(inc.owner, row);
      const set = slotBuyers.get(tx.slot) ?? new Set<string>();
      set.add(inc.owner);
      slotBuyers.set(tx.slot, set);
    }
  }
  if (parsed === 0 && failClosed) {
    return { ok: false, reason: "manip scan fail — could not parse early txs", ran: true };
  }
  let maxSameSlot = 0;
  let bundleSlot: number | null = null;
  for (const [slot, set] of slotBuyers) {
    if (set.size > maxSameSlot) {
      maxSameSlot = set.size;
      bundleSlot = slot;
    }
  }
  const funderGroups = new Map<string, Set<string>>();
  for (const [owner, info] of earlyBuyers) {
    for (const funder of info.funders) {
      const set = funderGroups.get(funder) ?? new Set<string>();
      set.add(owner);
      funderGroups.set(funder, set);
    }
  }
  let maxFunderCohort = 0;
  for (const set of funderGroups.values()) maxFunderCohort = Math.max(maxFunderCohort, set.size);
  if (maxSameSlot >= 3) {
    return {
      ok: false,
      reason: `bundlers: ${maxSameSlot} wallets bought same slot ${bundleSlot}`,
      ran: true,
      detail: { maxSameSlot, bundleSlot, parsed },
    };
  }
  if (maxFunderCohort >= 3) {
    return {
      ok: false,
      reason: `bundlers: ${maxFunderCohort} wallets funded by same source`,
      ran: true,
      detail: { maxFunderCohort, parsed },
    };
  }
  const holdBy = new Map<string, number>();
  for (const holder of input.topHolders ?? []) {
    const addr = holderAddr(holder);
    if (addr) holdBy.set(addr, pctOf(holder));
  }
  const firstCluster = new Set<string>();
  for (const [slot, set] of slotBuyers) {
    if (slot <= firstSlot + limits.manipEarlySlots) {
      for (const addr of set) firstCluster.add(addr);
    }
  }
  let bundleHold = 0;
  for (const addr of firstCluster) bundleHold += holdBy.get(addr) ?? 0;
  if (bundleHold > limits.bundleMaxPct) {
    return {
      ok: false,
      reason: `bundlers hold ${(bundleHold * 100).toFixed(0)}% > ${(limits.bundleMaxPct * 100).toFixed(0)}%`,
      ran: true,
      detail: { bundleHold, parsed },
    };
  }
  const sniperSet = new Set<string>();
  for (const [owner, info] of earlyBuyers) {
    for (const slot of info.slots) {
      if (slot <= firstSlot + limits.manipEarlySlots) {
        sniperSet.add(owner);
        break;
      }
    }
  }
  let sniperHold = 0;
  for (const addr of sniperSet) sniperHold += holdBy.get(addr) ?? 0;
  if (sniperHold > limits.sniperMaxPct) {
    return {
      ok: false,
      reason: `snipers hold ${(sniperHold * 100).toFixed(0)}% > ${(limits.sniperMaxPct * 100).toFixed(0)}% (first ${limits.manipEarlySlots} slots)`,
      ran: true,
      detail: { sniperHold, parsed },
    };
  }
  return {
    ok: true,
    reason: null,
    ran: true,
    detail: { parsed, maxSameSlot, maxFunderCohort, bundleHold, sniperHold, firstSlot },
  };
}

export function rugRiskPct(
  risks: Array<{ name?: string | null; value?: number | null; pct?: number | null }> | undefined,
  kind: "sniper" | "bundle"
): number {
  let max = 0;
  for (const risk of risks ?? []) {
    const name = (risk.name ?? "").toLowerCase();
    const match =
      kind === "sniper"
        ? name.includes("sniper")
        : name.includes("bundle") || name.includes("bundl");
    if (!match) continue;
    const value = Number(risk.value ?? risk.pct ?? 0);
    const pct = value > 1.5 ? value / 100 : value;
    max = Math.max(max, pct);
  }
  return max;
}

export function top10ExLp(
  holders: HolderRow[],
  limits: Limits = LIMITS
): { pct: number; over: boolean } {
  const pct = holders.slice(0, 10).reduce((sum, holder) => sum + pctOf(holder), 0);
  return { pct, over: pct > limits.maxTop10Pct };
}

export function badActorHit(
  addresses: Array<string | null | undefined>,
  badActors: ReadonlyMap<string, string> | Readonly<Record<string, string>>
): string | null {
  const lookup = badActors instanceof Map ? badActors : new Map(Object.entries(badActors));
  for (const addr of addresses) {
    if (!addr) continue;
    const reason = lookup.get(addr);
    if (reason) return `known bad actor ${addr.slice(0, 6)}… — ${reason}`;
  }
  return null;
}

export function devHoldReject(
  creator: string | null | undefined,
  holders: HolderRow[]
): string | null {
  if (!creator) return null;
  const row = holders.find((holder) => holderAddr(holder) === creator);
  const pct = row ? pctOf(row) : 0;
  if (pct > 0.1) return `dev/creator holds ${(pct * 100).toFixed(1)}% > 10%`;
  return null;
}
