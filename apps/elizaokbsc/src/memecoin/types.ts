export type DiscoverySource = "new_pools" | "trending_pools";

export interface DiscoveryConfig {
  enabled: boolean;
  runOnStartup: boolean;
  intervalMs: number;
  newPoolsLimit: number;
  trendingPoolsLimit: number;
  maxCandidates: number;
  memoTopCount: number;
  reportsDir: string;
  dashboard: DashboardConfig;
  goo: GooConfig;
}

export interface DashboardConfig {
  enabled: boolean;
  port: number;
}

export interface GooConfig {
  enabled: boolean;
  rpcUrl: string | null;
  registryAddress: string | null;
  lookbackBlocks: number;
  maxAgents: number;
  memoTopCount: number;
}

export interface PoolSnapshot {
  source: DiscoverySource;
  poolAddress: string;
  dexId: string;
  poolName: string;
  tokenAddress: string;
  tokenSymbol: string;
  quoteTokenAddress: string;
  quoteTokenSymbol: string;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  reserveUsd: number;
  volumeUsdM5: number;
  volumeUsdH1: number;
  buysM5: number;
  sellsM5: number;
  buyersM5: number;
  sellersM5: number;
  priceChangeH1: number;
  poolCreatedAt: string;
  poolAgeMinutes: number;
  fetchedAt: string;
}

export interface ScoredCandidate extends PoolSnapshot {
  score: number;
  recommendation: "simulate_buy" | "watch" | "observe" | "reject";
  conviction: "high" | "medium" | "low";
  thesis: string[];
  risks: string[];
}

export interface GooAgentCandidate {
  agentId: string;
  tokenAddress: string;
  ownerAddress: string;
  agentWallet: string;
  genomeUri: string;
  status: "ACTIVE" | "STARVING" | "DYING" | "DEAD" | "UNKNOWN";
  treasuryBnb: number;
  starvingThresholdBnb: number;
  minimumCtoBnb: number;
  secondsSinceLastPulse: number | null;
  secondsUntilPulseTimeout: number | null;
  registeredAtBlock: number;
  score: number;
  recommendation: "monitor" | "priority_due_diligence" | "cto_candidate" | "ignore";
  synergyThesis: string[];
  risks: string[];
}

export interface ScanSummary {
  runId: string;
  startedAt: string;
  completedAt: string;
  candidateCount: number;
  topRecommendationCount: number;
  averageScore: number;
  gooAgentCount: number;
  gooPriorityCount: number;
  strongestCandidate?: {
    tokenSymbol: string;
    score: number;
    recommendation: ScoredCandidate["recommendation"];
  };
  strongestGooCandidate?: {
    agentId: string;
    score: number;
    recommendation: GooAgentCandidate["recommendation"];
  };
}

export interface ScanMemo {
  title: string;
  markdown: string;
  summary: ScanSummary;
}

export interface DashboardSnapshot {
  generatedAt: string;
  summary: ScanSummary;
  topCandidates: ScoredCandidate[];
  topGooCandidates: GooAgentCandidate[];
  memoTitle: string;
  reportPath: string;
  snapshotPath: string;
}

export interface PersistedScanArtifacts {
  reportPath: string;
  snapshotPath: string;
  memoId: string;
  runMemoryId: string;
  candidateMemoryIds: string[];
  gooMemoryIds: string[];
}
