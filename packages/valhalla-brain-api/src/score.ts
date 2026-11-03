export interface ScoreFacts {
  liquidityUsd?: number | null;
  top10Pct?: number | null;
  mintAuthority?: boolean;
  freezeAuthority?: boolean;
  devActive?: boolean;
  lpLockedPct?: number | null;
  volumeAnomaly?: boolean;
}

export interface ScoreResult {
  score: number;
  flags: string[];
  disclaimer: string;
}

export const DISCLAIMER =
  "Informational only. Not financial advice. Valhalla does not promise profit.";

/** 0 to 100 from public facts. Missing facts lower the score. They do not invent safety. */
export function scoreFromFacts(facts: ScoreFacts): ScoreResult {
  let score = 70;
  const flags: string[] = [];
  if (facts.liquidityUsd == null) {
    score -= 15;
    flags.push("liquidity unknown");
  } else if (facts.liquidityUsd < 10_000) {
    score -= 25;
    flags.push("liquidity");
  }
  if (facts.top10Pct == null) {
    score -= 10;
    flags.push("holder concentration unknown");
  } else if (facts.top10Pct > 0.4) {
    score -= 20;
    flags.push("holder concentration");
  }
  if (facts.mintAuthority) {
    score = Math.min(score, 20);
    flags.push("mint authority");
  }
  if (facts.freezeAuthority) {
    score = Math.min(score, 20);
    flags.push("freeze authority");
  }
  if (facts.devActive) {
    score -= 10;
    flags.push("dev wallet activity");
  }
  if (facts.lpLockedPct == null) {
    score -= 10;
    flags.push("LP status unknown");
  } else if (facts.lpLockedPct < 5) {
    score -= 20;
    flags.push("LP status");
  }
  if (facts.volumeAnomaly) {
    score -= 15;
    flags.push("volume anomalies");
  }
  return {
    score: Math.max(0, Math.min(100, score)),
    flags,
    disclaimer: DISCLAIMER,
  };
}

/** A low score can mention a hardware wallet. The partner URL stays in offers.json. */
export function offerHint(
  score: number,
): { category: string; title: string; disclosure: string } | null {
  if (score > 40) return null;
  return {
    category: "hardware-wallet",
    title: "Protect your coins: hardware wallet",
    disclosure: "Affiliate link · we may earn a commission",
  };
}

export const PLAN_LIMITS = { free: 100, dev: 5_000, pro: 100_000 } as const;
export type PlanName = keyof typeof PLAN_LIMITS;

export function withinLimit(plan: PlanName, used: number): boolean {
  return used < PLAN_LIMITS[plan];
}
