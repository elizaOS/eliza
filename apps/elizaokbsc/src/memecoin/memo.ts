import type {
  GooAgentCandidate,
  ScanMemo,
  ScanSummary,
  ScoredCandidate,
} from "./types";

function formatUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "n/a";
  }

  return `$${value.toLocaleString(undefined, {
    maximumFractionDigits: value >= 1_000 ? 0 : 2,
  })}`;
}

function recommendationLabel(
  recommendation: ScoredCandidate["recommendation"],
): string {
  switch (recommendation) {
    case "simulate_buy":
      return "simulate buy";
    case "watch":
      return "watch";
    case "observe":
      return "observe";
    case "reject":
      return "reject";
  }
}

function gooRecommendationLabel(
  recommendation: GooAgentCandidate["recommendation"],
): string {
  switch (recommendation) {
    case "cto_candidate":
      return "cto candidate";
    case "priority_due_diligence":
      return "priority due diligence";
    case "monitor":
      return "monitor";
    case "ignore":
      return "ignore";
  }
}

function buildSummary(
  runId: string,
  startedAt: string,
  completedAt: string,
  candidates: ScoredCandidate[],
  gooCandidates: GooAgentCandidate[],
): ScanSummary {
  const averageScore =
    candidates.length > 0
      ? Math.round(
          candidates.reduce((sum, candidate) => sum + candidate.score, 0) /
            candidates.length,
        )
      : 0;

  const topRecommendationCount = candidates.filter(
    (candidate) => candidate.recommendation === "simulate_buy",
  ).length;

  const strongest = candidates[0];
  const strongestGoo = gooCandidates[0];
  const gooPriorityCount = gooCandidates.filter(
    (candidate) =>
      candidate.recommendation === "priority_due_diligence" ||
      candidate.recommendation === "cto_candidate",
  ).length;

  return {
    runId,
    startedAt,
    completedAt,
    candidateCount: candidates.length,
    topRecommendationCount,
    averageScore,
    gooAgentCount: gooCandidates.length,
    gooPriorityCount,
    strongestCandidate: strongest
      ? {
          tokenSymbol: strongest.tokenSymbol,
          score: strongest.score,
          recommendation: strongest.recommendation,
        }
      : undefined,
    strongestGooCandidate: strongestGoo
      ? {
          agentId: strongestGoo.agentId,
          score: strongestGoo.score,
          recommendation: strongestGoo.recommendation,
        }
      : undefined,
  };
}

export function buildScanMemo(
  runId: string,
  startedAt: string,
  completedAt: string,
  candidates: ScoredCandidate[],
  topCount: number,
  gooCandidates: GooAgentCandidate[],
  gooTopCount: number,
  gooEnabled: boolean,
): ScanMemo {
  const selected = candidates.slice(0, topCount);
  const selectedGoo = gooCandidates.slice(0, gooTopCount);
  const summary = buildSummary(
    runId,
    startedAt,
    completedAt,
    candidates,
    gooCandidates,
  );

  const lines: string[] = [
    `# ElizaOK Treasury Scan`,
    ``,
    `- Run ID: \`${runId}\``,
    `- Started at: \`${startedAt}\``,
    `- Completed at: \`${completedAt}\``,
    `- Candidates scanned: \`${summary.candidateCount}\``,
    `- Average score: \`${summary.averageScore}/100\``,
    `- Simulated-buy candidates: \`${summary.topRecommendationCount}\``,
    `- Goo agents reviewed: \`${summary.gooAgentCount}\``,
    `- Goo priority targets: \`${summary.gooPriorityCount}\``,
    ``,
    `## Top Candidates`,
    ``,
  ];

  if (selected.length === 0) {
    lines.push(`No candidates were strong enough to enter the memo shortlist.`);
  }

  for (const [index, candidate] of selected.entries()) {
    lines.push(
      `### ${index + 1}. ${candidate.tokenSymbol} on ${candidate.dexId}`,
    );
    lines.push(
      `- Recommendation: **${recommendationLabel(candidate.recommendation)}**`,
    );
    lines.push(
      `- Score: **${candidate.score}/100** (${candidate.conviction} conviction)`,
    );
    lines.push(
      `- FDV / Market Cap: ${formatUsd(candidate.fdvUsd)} / ${formatUsd(candidate.marketCapUsd)}`,
    );
    lines.push(`- Liquidity reserve: ${formatUsd(candidate.reserveUsd)}`);
    lines.push(
      `- Volume (5m / 1h): ${formatUsd(candidate.volumeUsdM5)} / ${formatUsd(candidate.volumeUsdH1)}`,
    );
    lines.push(
      `- Order flow (5m): buys ${candidate.buysM5}, sells ${candidate.sellsM5}, buyers ${candidate.buyersM5}`,
    );
    lines.push(`- Pool age: ${candidate.poolAgeMinutes} minutes`);
    lines.push(`- Discovery source: ${candidate.source}`);
    lines.push(`- Pool: \`${candidate.poolAddress}\``);
    lines.push(`- Token: \`${candidate.tokenAddress}\``);
    lines.push(`- Thesis: ${candidate.thesis.join(" ")}`);
    lines.push(`- Risks: ${candidate.risks.join(" ")}`);
    lines.push(``);
  }

  lines.push(`## Goo Turnaround Watchlist`);
  lines.push(``);

  if (!gooEnabled) {
    lines.push(`Goo scanning is currently disabled in environment settings.`);
    lines.push(``);
  } else if (selectedGoo.length === 0) {
    lines.push(`No Goo agents entered the current priority shortlist.`);
    lines.push(``);
  } else {
    for (const [index, candidate] of selectedGoo.entries()) {
      lines.push(`### ${index + 1}. Agent ${candidate.agentId}`);
      lines.push(
        `- Recommendation: **${gooRecommendationLabel(candidate.recommendation)}**`,
      );
      lines.push(`- Score: **${candidate.score}/100**`);
      lines.push(`- Lifecycle: **${candidate.status}**`);
      lines.push(`- Token: \`${candidate.tokenAddress}\``);
      lines.push(`- Agent wallet: \`${candidate.agentWallet}\``);
      lines.push(
        `- Treasury / starving threshold: ${candidate.treasuryBnb} BNB / ${candidate.starvingThresholdBnb} BNB`,
      );
      lines.push(`- Minimum CTO amount: ${candidate.minimumCtoBnb} BNB`);
      lines.push(
        `- Seconds until pulse timeout: ${candidate.secondsUntilPulseTimeout ?? "n/a"}`,
      );
      lines.push(`- Registered at block: ${candidate.registeredAtBlock}`);
      lines.push(`- Genome URI: ${candidate.genomeUri}`);
      lines.push(
        `- Thesis: ${candidate.synergyThesis.join(" ") || "No synergy thesis generated."}`,
      );
      lines.push(
        `- Risks: ${candidate.risks.join(" ") || "No major risk flags."}`,
      );
      lines.push(``);
    }
  }

  lines.push(`## Treasury Takeaway`);
  lines.push(``);

  if (summary.topRecommendationCount > 0) {
    lines.push(
      `The scan found ${summary.topRecommendationCount} candidate(s) strong enough for simulated treasury entry. The next action is to track follow-up scans and compare liquidity and order-flow persistence before enabling live execution.`,
    );
  } else if (summary.candidateCount > 0) {
    lines.push(
      `No candidate passed the simulated-buy threshold in this run, but the top watchlist names should stay under monitoring for liquidity growth and cleaner buy-side flow.`,
    );
  } else {
    lines.push(`No usable pool data was returned in this cycle.`);
  }

  if (summary.gooPriorityCount > 0) {
    lines.push(
      `In parallel, ${summary.gooPriorityCount} Goo agent(s) look worthy of turnaround due diligence, which can become the second alpha lane after memecoin discovery.`,
    );
  }

  return {
    title: `ElizaOK Treasury Scan ${completedAt}`,
    markdown: lines.join("\n"),
    summary,
  };
}
