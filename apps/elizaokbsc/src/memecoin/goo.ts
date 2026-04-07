import { ethers } from "ethers";
import type { GooAgentCandidate, GooConfig } from "./types";

const STATUS_NAMES = ["ACTIVE", "STARVING", "DYING", "DEAD"] as const;

const REGISTRY_ABI = [
  "event AgentRegistered(uint256 indexed agentId, address indexed tokenContract, address indexed owner, address agentWallet, string genomeURI)",
  "function ownerOf(uint256 agentId) view returns (address)",
] as const;

const TOKEN_ABI = [
  "function getAgentStatus() view returns (uint8)",
  "function treasuryBalance() view returns (uint256)",
  "function starvingThreshold() view returns (uint256)",
  "function lastPulseAt() view returns (uint256)",
  "function PULSE_TIMEOUT_SECS() view returns (uint256)",
  "function minCtoAmount() view returns (uint256)",
] as const;

function normalizeStatus(statusRaw: bigint): GooAgentCandidate["status"] {
  return STATUS_NAMES[Number(statusRaw)] || "UNKNOWN";
}

function scoreGenomeSynergy(genomeUri: string, thesis: string[]): number {
  const lower = genomeUri.toLowerCase();
  let score = 0;

  if (/(alpha|trade|treasury|defi|market|liquidity|yield|quant)/.test(lower)) {
    score += 16;
    thesis.push(
      "Genome URI suggests direct overlap with treasury, trading, or DeFi alpha.",
    );
  }

  if (/(social|meme|content|community|signal|discovery)/.test(lower)) {
    score += 12;
    thesis.push(
      "Genome URI suggests social or discovery signals that can strengthen memecoin scouting.",
    );
  }

  if (/(bnb|bsc|pancake|four\.meme)/.test(lower)) {
    score += 8;
    thesis.push(
      "Genome URI looks BNB-native, which improves execution relevance for ElizaOK.",
    );
  }

  return score;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function toRecommendation(score: number): GooAgentCandidate["recommendation"] {
  if (score >= 75) return "cto_candidate";
  if (score >= 58) return "priority_due_diligence";
  if (score >= 40) return "monitor";
  return "ignore";
}

function scoreGooCandidate(
  candidate: Omit<
    GooAgentCandidate,
    "score" | "recommendation" | "synergyThesis" | "risks"
  >,
): GooAgentCandidate {
  let score = 25;
  const synergyThesis: string[] = [];
  const risks: string[] = [];

  if (candidate.status === "DYING") {
    score += 26;
    synergyThesis.push(
      "Agent is already in DYING, so it fits the turnaround window.",
    );
  } else if (candidate.status === "STARVING") {
    score += 14;
    synergyThesis.push(
      "Agent is STARVING, making it a near-term turnaround candidate.",
    );
  } else if (candidate.status === "ACTIVE") {
    score -= 8;
    risks.push(
      "Agent is still ACTIVE, so it is not yet a true turnaround target.",
    );
  } else if (candidate.status === "DEAD") {
    score -= 22;
    risks.push("Agent is already DEAD and outside the CTO path.");
  } else {
    score -= 10;
    risks.push("Agent lifecycle state is unclear.");
  }

  score += scoreGenomeSynergy(candidate.genomeUri, synergyThesis);

  if (candidate.minimumCtoBnb > 0 && candidate.minimumCtoBnb <= 0.2) {
    score += 12;
    synergyThesis.push(
      "Minimum CTO amount is relatively cheap for an experimental acquisition.",
    );
  } else if (candidate.minimumCtoBnb > 1) {
    score -= 12;
    risks.push("Minimum CTO amount is expensive for an MVP treasury strategy.");
  }

  if (candidate.treasuryBnb > 0.2) {
    score += 10;
    synergyThesis.push(
      "Treasury still holds meaningful BNB that may justify rescue.",
    );
  } else if (candidate.treasuryBnb < candidate.starvingThresholdBnb) {
    score += 6;
    synergyThesis.push("Treasury stress aligns with the turnaround thesis.");
  }

  if (
    candidate.secondsUntilPulseTimeout !== null &&
    candidate.secondsUntilPulseTimeout < 3_600
  ) {
    score += 8;
    synergyThesis.push(
      "Pulse timeout is approaching, making the opportunity time-sensitive.",
    );
  }

  if (!candidate.genomeUri || candidate.genomeUri === "unknown") {
    score -= 8;
    risks.push("Genome URI is missing, so synergy is harder to validate.");
  }

  const finalScore = clampScore(score);
  return {
    ...candidate,
    score: finalScore,
    recommendation: toRecommendation(finalScore),
    synergyThesis,
    risks,
  };
}

export async function discoverGooCandidates(
  config: GooConfig,
): Promise<GooAgentCandidate[]> {
  if (!config.enabled || !config.rpcUrl || !config.registryAddress) {
    return [];
  }

  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const latestBlock = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latestBlock - config.lookbackBlocks);
  const registry = new ethers.Contract(
    config.registryAddress,
    REGISTRY_ABI,
    provider,
  );

  const registeredEvents = await registry.queryFilter(
    registry.filters.AgentRegistered(),
    fromBlock,
    latestBlock,
  );

  const recentEvents = registeredEvents
    .filter((event): event is ethers.EventLog => "args" in event)
    .slice(-config.maxAgents)
    .reverse();
  const candidates = await Promise.all(
    recentEvents.map(async (event) => {
      const args = event.args;
      if (!args) return null;

      const agentId = args[0]?.toString();
      const tokenAddress = String(args[1] || "").toLowerCase();
      const ownerAddress = String(args[2] || "").toLowerCase();
      const agentWallet = String(args[3] || "").toLowerCase();
      const genomeUri = String(args[4] || "");
      if (!agentId || !tokenAddress) return null;

      const token = new ethers.Contract(tokenAddress, TOKEN_ABI, provider);
      const [
        statusRaw,
        treasuryBalance,
        starvingThreshold,
        lastPulseAt,
        pulseTimeout,
        minimumCtoAmount,
      ] = await Promise.all([
        token.getAgentStatus() as Promise<bigint>,
        token.treasuryBalance() as Promise<bigint>,
        token.starvingThreshold() as Promise<bigint>,
        token.lastPulseAt() as Promise<bigint>,
        token.PULSE_TIMEOUT_SECS() as Promise<bigint>,
        token.minCtoAmount() as Promise<bigint>,
      ]);

      const now = Math.floor(Date.now() / 1000);
      const lastPulseNum = Number(lastPulseAt);
      const pulseTimeoutSecs = Number(pulseTimeout);
      const secondsSinceLastPulse =
        lastPulseNum > 0 ? Math.max(0, now - lastPulseNum) : null;
      const secondsUntilPulseTimeout =
        secondsSinceLastPulse === null
          ? null
          : Math.max(0, pulseTimeoutSecs - secondsSinceLastPulse);

      return scoreGooCandidate({
        agentId,
        tokenAddress,
        ownerAddress,
        agentWallet,
        genomeUri: genomeUri || "unknown",
        status: normalizeStatus(statusRaw),
        treasuryBnb: Number.parseFloat(ethers.formatEther(treasuryBalance)),
        starvingThresholdBnb: Number.parseFloat(
          ethers.formatEther(starvingThreshold),
        ),
        minimumCtoBnb: Number.parseFloat(ethers.formatEther(minimumCtoAmount)),
        secondsSinceLastPulse,
        secondsUntilPulseTimeout,
        registeredAtBlock: event.blockNumber,
      });
    }),
  );

  return candidates
    .filter((candidate): candidate is GooAgentCandidate => Boolean(candidate))
    .sort((a, b) => b.score - a.score);
}
