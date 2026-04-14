/**
 * KOL Take-Profit Engine
 *
 * Reverse-engineers KOL trading patterns and uses them to generate
 * adaptive take-profit rules for elizaOK's portfolio positions.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchKolHolders, profileKolStrategy, type KolProfitProfile } from "./gmgn-service";

export interface KolTpCache {
  profiles: Record<string, KolProfitProfile>;
  lastUpdatedAt: string | null;
  totalProfiled: number;
}

export interface KolAdaptiveTp {
  tokenAddress: string;
  kolCount: number;
  avgKolTakeProfitPct: number;
  medianKolTakeProfitPct: number;
  avgKolWinRate: number;
  recommendedTpPct: number;
  confidence: "high" | "medium" | "low";
}

const CACHE_FILE = "kol-tp-cache.json";
const PROFILE_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

let memCache: KolTpCache = {
  profiles: {},
  lastUpdatedAt: null,
  totalProfiled: 0,
};

export async function loadKolTpCache(reportsDir: string): Promise<KolTpCache> {
  try {
    const raw = await readFile(path.join(reportsDir, CACHE_FILE), "utf-8");
    memCache = JSON.parse(raw);
    return memCache;
  } catch {
    return memCache;
  }
}

export async function saveKolTpCache(reportsDir: string): Promise<void> {
  await writeFile(
    path.join(reportsDir, CACHE_FILE),
    JSON.stringify(memCache, null, 2),
    "utf-8",
  );
}

/**
 * Profile KOLs holding a specific token and return adaptive TP recommendation.
 */
export async function analyzeKolTakeProfit(
  tokenAddress: string,
): Promise<KolAdaptiveTp | null> {
  try {
    const kolData = await fetchKolHolders(tokenAddress);
    if (!kolData || kolData.kolCount === 0) return null;

    const kolAddresses = kolData.kolHolders
      ?.map((h: any) => h.address || h.wallet_address)
      ?.filter(Boolean)
      ?.slice(0, 5) ?? [];

    if (kolAddresses.length === 0) return null;

    const profiles: KolProfitProfile[] = [];
    for (const addr of kolAddresses) {
      const cached = memCache.profiles[addr];
      if (cached && memCache.lastUpdatedAt) {
        const age = Date.now() - new Date(memCache.lastUpdatedAt).getTime();
        if (age < PROFILE_CACHE_TTL_MS) {
          profiles.push(cached);
          continue;
        }
      }

      try {
        const profile = await profileKolStrategy(addr, "KOL");
        if (profile) {
          memCache.profiles[addr] = profile;
          memCache.totalProfiled++;
          profiles.push(profile);
        }
        await new Promise(r => setTimeout(r, 300));
      } catch {
        // skip failed profiles
      }
    }

    memCache.lastUpdatedAt = new Date().toISOString();

    if (profiles.length === 0) return null;

    const avgTp = profiles.reduce((s, p) => s + p.avgTakeProfitPct, 0) / profiles.length;
    const medianTp = profiles.reduce((s, p) => s + p.medianTakeProfitPct, 0) / profiles.length;
    const avgWr = profiles.reduce((s, p) => s + p.winRate, 0) / profiles.length;

    // Recommended TP: use the lower of avg/median, biased toward taking profits earlier
    const recommendedTp = Math.max(15, Math.min(avgTp, medianTp) * 0.8);

    const confidence: KolAdaptiveTp["confidence"] =
      profiles.length >= 3 && avgWr > 40 ? "high" :
      profiles.length >= 2 ? "medium" : "low";

    return {
      tokenAddress,
      kolCount: profiles.length,
      avgKolTakeProfitPct: avgTp,
      medianKolTakeProfitPct: medianTp,
      avgKolWinRate: avgWr,
      recommendedTpPct: recommendedTp,
      confidence,
    };
  } catch {
    return null;
  }
}

/**
 * Scan portfolio positions and generate KOL-adaptive TP signals.
 * Returns a map of tokenAddress → recommended TP percentage.
 */
export async function scanPortfolioForKolTp(
  positions: Array<{ tokenAddress: string; tokenSymbol: string }>,
  maxToScan: number = 8,
): Promise<Record<string, KolAdaptiveTp>> {
  const results: Record<string, KolAdaptiveTp> = {};
  const toScan = positions.slice(0, maxToScan);

  for (const pos of toScan) {
    try {
      const tp = await analyzeKolTakeProfit(pos.tokenAddress);
      if (tp) {
        results[pos.tokenAddress] = tp;
      }
      await new Promise(r => setTimeout(r, 400));
    } catch {
      // skip
    }
  }

  return results;
}
