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
  historyLimit: number;
  treasury: TreasuryConfig;
  execution: ExecutionConfig;
  distribution: DistributionConfig;
  goo: GooConfig;
}

export interface DashboardConfig {
  enabled: boolean;
  port: number;
}

export interface DistributionConfig {
  enabled: boolean;
  snapshotPath: string;
  holderTokenAddress: string | null;
  minEligibleBalance: number;
  maxRecipients: number;
  poolPct: number;
  startBlock: number | null;
  execution: DistributionExecutionConfig;
}

export interface DistributionExecutionConfig {
  enabled: boolean;
  dryRun: boolean;
  autoSelectAsset: boolean;
  assetTokenAddress: string | null;
  assetTotalAmount: string | null;
  walletAddress: string | null;
  privateKey: string | null;
  liveConfirmPhrase: string;
  liveConfirmArmed: boolean;
  maxRecipientsPerRun: number;
  requireVerifiedWallet: boolean;
  requirePositivePnl: boolean;
  requireTakeProfitHit: boolean;
  minWalletQuoteUsd: number;
  minPortfolioSharePct: number;
}

export interface TreasuryConfig {
  paperCapitalUsd: number;
  maxActivePositions: number;
  reservePct: number;
  takeProfitRules: TreasuryTakeProfitRule[];
  stopLossPct: number;
  exitScoreThreshold: number;
  trailingStopPct: number;
  trailingStopActivatePct: number;
  gmgnExitEnabled: boolean;
  holderDropExitThreshold: number;
  kolExitEnabled: boolean;
  topHolderDumpPct: number;
}

export interface TreasuryTakeProfitRule {
  label: string;
  gainPct: number;
  sellPct: number;
}

export type ExecutionMode = "paper" | "live_buy_only" | "live_full";
export type ExecutionRouter = "fourmeme" | "pancakeswap";

export interface ExecutionRiskConfig {
  maxBuyBnb: number;
  maxDailyDeployBnb: number;
  maxSlippageBps: number;
  maxActivePositions: number;
  minEntryMcapUsd: number;
  maxEntryMcapUsd: number;
  minLiquidityUsd: number;
  minVolumeUsdM5: number;
  minVolumeUsdH1: number;
  minBuyersM5: number;
  minNetBuysM5: number;
  minPoolAgeMinutes: number;
  maxPoolAgeMinutes: number;
  maxPriceChangeH1Pct: number;
  allowedQuoteOnly: boolean;
}

export interface ExecutionKolConfig {
  enabled: boolean;
  walletsPath: string | null;
  minHolderCount: number;
  publicSourceEnabled: boolean;
  publicSourceTokenLimit: number;
  publicSourceLookbackBlocks: number;
  publicSourceMinTokenHits: number;
  publicSourceWalletLimit: number;
  publicCachePath: string | null;
}

export interface ExecutionKolSupport {
  enabled: boolean;
  trackedWalletCount: number;
  holderCount: number;
  qualified: boolean;
  reason: string;
}

export interface ExecutionConfig {
  enabled: boolean;
  dryRun: boolean;
  dryRunCooldownMs: number;
  liveConfirmPhrase: string;
  liveConfirmValue: string | null;
  liveConfirmArmed: boolean;
  mode: ExecutionMode;
  router: ExecutionRouter;
  rpcUrl: string | null;
  walletAddress: string | null;
  privateKey: string | null;
  privateKeyConfigured: boolean;
  fourMemeCliCommand: string;
  fourMemeBuyTemplate: string | null;
  risk: ExecutionRiskConfig;
  kol: ExecutionKolConfig;
  maxBuysPerCycle: number;
}

export interface ExecutionCandidatePlan {
  tokenAddress: string;
  tokenSymbol: string;
  recommendation: ScoredCandidate["recommendation"];
  score: number;
  plannedBuyBnb: number;
  route: ExecutionRouter;
  eligible: boolean;
  routeTradable: "unchecked" | "tradable" | "blocked";
  routeReason?: string;
  resolvedRoute?: "fourmeme" | "pancakeswap" | null;
  kolSupport?: ExecutionKolSupport;
  reasons: string[];
}

export interface ExecutionReadinessCheck {
  label: string;
  ready: boolean;
  detail: string;
}

export interface ExecutionState {
  enabled: boolean;
  dryRun: boolean;
  mode: ExecutionMode;
  router: ExecutionRouter;
  configured: boolean;
  liveTradingArmed: boolean;
  readinessScore: number;
  readinessTotal: number;
  readinessChecks: ExecutionReadinessCheck[];
  nextAction: string;
  risk: ExecutionRiskConfig;
  gooLane?: ExecutionGooLane;
  plans: ExecutionCandidatePlan[];
  cycleSummary: ExecutionCycleSummary;
}

export interface ExecutionGooProposal {
  agentId: string;
  tokenAddress: string;
  status: GooAgentCandidate["status"];
  recommendation: GooAgentCandidate["recommendation"];
  minimumCtoBnb: number;
  treasuryBnb: number;
  reserveBnb: number;
  action: "ignore" | "monitor" | "due_diligence" | "reserve_treasury";
  reason: string;
}

export interface ExecutionGooLane {
  enabled: boolean;
  reviewedCount: number;
  priorityCount: number;
  reserveBnb: number;
  blocksMemecoinBuys: boolean;
  note: string;
  proposals: ExecutionGooProposal[];
}

export interface ExecutionCycleSummary {
  consideredCount: number;
  eligibleCount: number;
  attemptedCount: number;
  dryRunCount: number;
  executedCount: number;
  skippedCount: number;
  failedCount: number;
  note: string;
}

export type TradeDisposition = "dry_run" | "executed" | "skipped" | "failed";

export interface TradeRecord {
  id: string;
  runId: string;
  generatedAt: string;
  side?: "buy" | "sell";
  router: ExecutionRouter;
  mode: ExecutionMode;
  tokenAddress: string;
  tokenSymbol: string;
  plannedBuyBnb: number;
  plannedBuyUsd?: number | null;
  bnbUsdPrice?: number | null;
  entryReferenceUsd?: number | null;
  fundsBnb: number | null;
  fundsWei: string | null;
  tokenAmount?: string | null;
  quoteBnb?: number | null;
  quoteUsd?: number | null;
  disposition: TradeDisposition;
  reason: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  txHash?: string | null;
}

export interface TradeLedger {
  records: TradeRecord[];
  lastUpdatedAt: string | null;
  totalExecutedBnb: number;
  totalDryRunBnb: number;
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
  recommendation:
    | "monitor"
    | "priority_due_diligence"
    | "cto_candidate"
    | "ignore";
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

export interface SimulatedPosition {
  tokenSymbol: string;
  tokenAddress: string;
  recommendation: ScoredCandidate["recommendation"];
  score: number;
  allocationUsd: number;
  allocationPct: number;
  fdvUsd: number | null;
  reserveUsd: number;
  source: DiscoverySource;
  thesis: string[];
}

export interface TreasurySimulation {
  paperCapitalUsd: number;
  deployableCapitalUsd: number;
  allocatedUsd: number;
  dryPowderUsd: number;
  reserveUsd: number;
  reservePct: number;
  positionCount: number;
  averagePositionUsd: number;
  highestConvictionSymbol?: string;
  strategyNote: string;
  positions: SimulatedPosition[];
}

export type PortfolioPositionState = "active" | "watch" | "exited";

export interface PortfolioPosition {
  tokenAddress: string;
  tokenSymbol: string;
  executionSource: "paper" | "live" | "hybrid";
  walletVerification: "unverified" | "present" | "empty" | "error";
  walletTokenBalance: string | null;
  walletTokenDecimals: number | null;
  walletCheckedAt: string | null;
  walletQuoteRoute: "fourmeme" | "pancakeswap" | null;
  walletQuoteBnb: number | null;
  walletQuoteUsd: number | null;
  firstSeenAt: string;
  lastUpdatedAt: string;
  state: PortfolioPositionState;
  source: DiscoverySource;
  thesis: string[];
  costBasisBnb: number | null;
  initialAllocationUsd: number;
  entryScore: number;
  currentScore: number;
  allocationUsd: number;
  currentValueUsd: number;
  totalProceedsUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  entryReferenceUsd: number | null;
  currentReferenceUsd: number | null;
  lastRecommendation: ScoredCandidate["recommendation"];
  lastConviction: ScoredCandidate["conviction"];
  appearanceCount: number;
  takeProfitCount: number;
  takeProfitStagesHit: string[];
  exitReason?: string;
  peakValueUsd?: number;
  peakPnlPct?: number;
  trailingStopTriggered?: boolean;
  gmgnExitReason?: string;
}

export interface TreasuryTimelineEvent {
  runId: string;
  generatedAt: string;
  type:
    | "entered"
    | "promoted"
    | "watched"
    | "exited"
    | "rebalanced"
    | "take_profit";
  tokenAddress: string;
  tokenSymbol: string;
  detail: string;
  stateAfter: PortfolioPositionState;
}

export interface PortfolioFlywheel {
  totalProfitUsd: number;
  reinvestedUsd: number;
  elizaOKBuybackUsd: number;
  airdropReserveUsd: number;
  cycleCount: number;
  lastCycleAt: string | null;
  trailingStopSaves: number;
  gmgnExitSaves: number;
}

export interface PortfolioLifecycle {
  activePositions: PortfolioPosition[];
  watchPositions: PortfolioPosition[];
  exitedPositions: PortfolioPosition[];
  timeline: TreasuryTimelineEvent[];
  cashBalanceUsd: number;
  grossPortfolioValueUsd: number;
  reservedUsd: number;
  totalAllocatedUsd: number;
  totalCurrentValueUsd: number;
  totalRealizedPnlUsd: number;
  totalUnrealizedPnlUsd: number;
  totalUnrealizedPnlPct: number;
  healthNote: string;
  flywheel: PortfolioFlywheel;
  winCount: number;
  lossCount: number;
}

export interface HistoryEntry {
  runId: string;
  generatedAt: string;
  candidateCount: number;
  topRecommendationCount: number;
  averageScore: number;
  gooAgentCount: number;
  gooPriorityCount: number;
  strongestCandidate?: ScanSummary["strongestCandidate"];
  treasuryAllocatedUsd: number;
  treasuryDryPowderUsd: number;
}

export interface CandidateRunRecord {
  runId: string;
  generatedAt: string;
  tokenSymbol: string;
  tokenAddress: string;
  poolAddress: string;
  dexId: string;
  score: number;
  recommendation: ScoredCandidate["recommendation"];
  conviction: ScoredCandidate["conviction"];
  reserveUsd: number;
  volumeUsdM5: number;
  volumeUsdH1: number;
  buysM5: number;
  sellersM5: number;
  buyersM5: number;
  poolAgeMinutes: number;
  priceChangeH1: number;
  fdvUsd: number | null;
  marketCapUsd: number | null;
  thesis: string[];
  risks: string[];
}

export interface CandidateDetail {
  tokenAddress: string;
  tokenSymbol: string;
  latest: CandidateRunRecord;
  history: CandidateRunRecord[];
}

export interface PortfolioPositionDetail {
  tokenAddress: string;
  tokenSymbol: string;
  position: PortfolioPosition | null;
  timeline: TreasuryTimelineEvent[];
}

export interface CandidateWatchlistEntry {
  tokenAddress: string;
  tokenSymbol: string;
  currentScore: number;
  currentRecommendation: ScoredCandidate["recommendation"];
  currentConviction: ScoredCandidate["conviction"];
  appearances: number;
  firstSeenAt: string;
  lastSeenAt: string;
  bestScore: number;
  averageScore: number;
  scoreChange: number;
  reserveUsd: number;
  volumeUsdM5: number;
  thesis: string[];
  risks: string[];
}

export interface HolderSnapshotEntry {
  address: string;
  balance: number;
  label?: string;
}

export interface DistributionRecipient {
  address: string;
  label?: string;
  balance: number;
  allocationUsd: number;
  allocationPct: number;
  allocationBps: number;
}

export interface DistributionPublication {
  title: string;
  markdown: string;
  announcement: string;
  manifestPath: string | null;
  publicationPath: string | null;
}

export interface DistributionAssetSelection {
  mode: "manual" | "auto" | "none";
  tokenAddress: string | null;
  tokenSymbol: string | null;
  totalAmount: string | null;
  walletBalance: string | null;
  walletQuoteUsd: number | null;
  sourcePositionTokenAddress: string | null;
  reason: string;
}

export interface DistributionPlan {
  enabled: boolean;
  holderTokenAddress: string | null;
  snapshotPath: string;
  snapshotSource: "file" | "onchain" | "none";
  snapshotGeneratedAt: string | null;
  snapshotBlockNumber: number | null;
  minEligibleBalance: number;
  eligibleHolderCount: number;
  totalQualifiedBalance: number;
  distributionPoolUsd: number;
  maxRecipients: number;
  note: string;
  selectedAsset: DistributionAssetSelection;
  recipients: DistributionRecipient[];
  publication: DistributionPublication | null;
}

export interface DistributionExecutionReadinessCheck {
  label: string;
  ready: boolean;
  detail: string;
}

export interface DistributionExecutionRecord {
  id: string;
  generatedAt: string;
  manifestFingerprint: string;
  recipientAddress: string;
  amount: string;
  amountRaw: string;
  disposition: "dry_run" | "executed" | "skipped" | "failed";
  reason: string;
  txHash: string | null;
}

export interface DistributionExecutionLedger {
  records: DistributionExecutionRecord[];
  lastUpdatedAt: string | null;
  totalRecipientsExecuted: number;
  totalRecipientsDryRun: number;
}

export interface DistributionExecutionSummary {
  attemptedCount: number;
  dryRunCount: number;
  executedCount: number;
  skippedCount: number;
  failedCount: number;
  note: string;
}

export interface DistributionExecutionState {
  enabled: boolean;
  dryRun: boolean;
  configured: boolean;
  liveExecutionArmed: boolean;
  readinessScore: number;
  readinessTotal: number;
  readinessChecks: DistributionExecutionReadinessCheck[];
  nextAction: string;
  assetTokenAddress: string | null;
  assetTotalAmount: string | null;
  walletAddress: string | null;
  manifestPath: string | null;
  manifestFingerprint: string | null;
  maxRecipientsPerRun: number;
  cycleSummary: DistributionExecutionSummary;
}

export interface DashboardSnapshot {
  generatedAt: string;
  summary: ScanSummary;
  treasurySimulation: TreasurySimulation;
  portfolioLifecycle: PortfolioLifecycle;
  executionState: ExecutionState;
  tradeLedger: TradeLedger;
  distributionPlan: DistributionPlan;
  distributionExecution: DistributionExecutionState;
  distributionLedger: DistributionExecutionLedger;
  recentHistory: HistoryEntry[];
  watchlist: CandidateWatchlistEntry[];
  topCandidates: ScoredCandidate[];
  topGooCandidates: GooAgentCandidate[];
  memoTitle: string;
  reportPath: string;
  snapshotPath: string;
}

export interface PersistedScanArtifacts {
  reportPath: string;
  snapshotPath: string;
  historyPath: string;
  watchlistPath: string;
  candidateHistoryPath: string;
  distributionPath: string;
  distributionExecutionPath: string;
  distributionLedgerPath: string;
  portfolioPath: string;
  timelinePath: string;
  executionPath: string;
  tradesPath: string;
  memoId: string;
  runMemoryId: string;
  candidateMemoryIds: string[];
  gooMemoryIds: string[];
}
