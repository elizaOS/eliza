import type { RugSummary } from "./filters.ts";

/** 0 to 100. Mint or freeze authority, unlocked LP, or a crowded top 10 lowers it. */
export function safetyScore(report: RugSummary | null): { score: number; reasons: string[] } {
  if (!report) return { score: 0, reasons: ["no RugCheck report"] };
  let score = 100;
  const reasons: string[] = [];
  if (report.mintAuthority) {
    score = 0;
    reasons.push("mint authority");
  }
  if (report.freezeAuthority) {
    score = 0;
    reasons.push("freeze authority");
  }
  const danger = (report.risks ?? []).filter((risk) => {
    const level = String(risk.level ?? "").toLowerCase();
    return (
      level === "danger" ||
      String(risk.name ?? "")
        .toLowerCase()
        .includes("danger")
    );
  });
  if (danger.length) {
    score -= 30 * danger.length;
    reasons.push("danger flags");
  }
  const top = (report.topHolders ?? [])
    .slice(0, 10)
    .reduce((sum, holder) => sum + Number(holder.pct ?? 0), 0);
  const topPct = top > 1.5 ? top / 100 : top;
  if (topPct > 0.4) {
    score -= 40;
    reasons.push("top holders");
  }
  const locked = report.markets?.[0]?.lp?.lpLockedPct;
  if (locked != null && Number(locked) < 5) {
    score -= 40;
    reasons.push("LP lock");
  }
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/** Extra gate on top of the existing rug checks. A missing report does not open a new pass. */
export function extraSafetyGate(report: RugSummary | null): { ok: boolean; reason: string } {
  const scored = safetyScore(report);
  if (!report) return { ok: false, reason: "safety score unavailable" };
  if (scored.score < 50) return { ok: false, reason: `safety ${scored.score}` };
  return { ok: true, reason: `safety ${scored.score}` };
}
