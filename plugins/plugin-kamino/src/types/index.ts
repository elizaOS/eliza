import type { KaminoObligation } from "@kamino-finance/klend-sdk";

// ─── Market Registry ────────────────────────────────────────────────────────

export interface MarketConfig {
  name: string; // e.g. "Main", "JLP", "SOL-Only"
  address: string; // market pubkey
  description?: string; // for LLM context
}

export interface KaminoPluginSettings {
  /** RPC endpoint */
  rpcUrl: string;
  /** WebSocket endpoint for tx confirmations (auto-derived from rpcUrl if omitted) */
  wsUrl: string;
  /** Markets to load (defaults to Main market if empty) */
  markets: MarketConfig[];
  /** Private key as base58 string */
  privateKey?: string;
  /** Path to keypair JSON file */
  keypairPath?: string;
  /** Auto-refresh interval in ms (default: 30000) */
  refreshIntervalMs: number;
}

// ─── Reserve Data ───────────────────────────────────────────────────────────

export interface ReserveInfo {
  symbol: string;
  mint: string;
  marketName: string; // which market this reserve belongs to
  supplyAPY: string;
  borrowAPY: string;
  totalDeposits: string;
  totalBorrows: string;
  availableLiquidity: string;
  ltv: string;
  liquidationThreshold: string;
  depositEnabled: boolean;
  borrowEnabled: boolean;
}

// ─── Position Data ──────────────────────────────────────────────────────────

export interface PositionInfo {
  marketName: string;
  deposits: PositionDeposit[];
  borrows: PositionBorrow[];
  healthFactor: string;
  borrowLimit: string;
  netValue: string;
  ltv: string;
}

export interface PositionDeposit {
  symbol: string;
  amount: string;
  valueUsd: string;
}

export interface PositionBorrow {
  symbol: string;
  amount: string;
  valueUsd: string;
  borrowAPY: string;
}

// ─── Parsed Action Params ───────────────────────────────────────────────────

export interface DepositParams {
  token: string;
  amount: string;
  marketName?: string; // defaults to first market or "Main"
}

export interface BorrowParams {
  token: string;
  amount: string;
  marketName?: string;
}

export interface RepayParams {
  token: string;
  amount: string | "max";
  marketName?: string;
}

export interface WithdrawParams {
  token: string;
  amount: string | "max";
  marketName?: string;
}

export interface CachedObligation {
  obligation: KaminoObligation;
  fetchedAt: number;
}

// ─── Health Check ───────────────────────────────────────────────────────────

export interface HealthCheckResult {
  positions: PositionInfo[];
  hasPositions: boolean;
  overallRisk: "safe" | "caution" | "danger" | "critical";
  worstHealthFactor: string;
}
