/**
 * Response shapes returned by hyperD endpoints used in v0.1.
 *
 * Mirrors the actual API at api.hyperd.ai. If hyperD adds or renames fields,
 * update here — the actions destructure these shapes for human-readable
 * callback summaries.
 */

export interface WalletRiskResponse {
  address: string;
  sanctioned: boolean;
  risk_tier: "low" | "medium" | "high" | "unknown";
  categories: string[];
  sources: { chainalysis: string; goplus: string };
  generated_at: string;
}

export interface TokenSecurityResponse {
  contract: string;
  chain: string;
  security_score: number; // 0–100, higher = safer
  honeypot: boolean;
  owner_can_mint: boolean;
  owner_can_blacklist: boolean;
  buy_tax_pct: number;
  sell_tax_pct: number;
  holder_concentration_top10_pct: number;
  notes: string[];
  generated_at: string;
}

export interface LiquidationRiskResponse {
  address: string;
  chain: string;
  composite_health_factor: number | null; // null = no positions
  liquidation_imminent: boolean;
  positions: Array<{
    protocol: "aave-v3" | "compound-v3" | "spark" | "morpho";
    health_factor: number;
    collateral_usd: number;
    debt_usd: number;
    liquidation_price_usd?: number;
  }>;
  recommended_add_collateral_usd?: number;
  generated_at: string;
}

export interface WalletPnlResponse {
  address: string;
  chain: string;
  window: string;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  total_pnl_usd: number;
  per_token: Array<{
    symbol: string;
    realized_pnl_usd: number;
    unrealized_pnl_usd: number;
    cost_basis_usd: number;
    market_value_usd: number;
  }>;
  generated_at: string;
}

export interface DexQuoteResponse {
  from: string;
  to: string;
  amount_in: string;
  chain: string;
  best: {
    source: "paraswap" | "0x" | string;
    amount_out: string;
    gas_estimate: string;
    slippage_pct: number;
  };
  alternatives: Array<{
    source: string;
    amount_out: string;
    gas_estimate: string;
  }>;
  generated_at: string;
}

/** Shared response wrapper for any 4xx the API returns instead of a payload. */
export interface HyperdErrorResponse {
  error: string;
  message?: string;
  hint?: string;
}

export type HyperdAnyResponse =
  | WalletRiskResponse
  | TokenSecurityResponse
  | LiquidationRiskResponse
  | WalletPnlResponse
  | DexQuoteResponse;
