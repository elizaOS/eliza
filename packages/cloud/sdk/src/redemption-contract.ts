/**
 * Canonical isomorphic HTTP contract for earnings redemption. This module is
 * dependency-free so the SDK, browser UI, Worker routes, and server services
 * consume the same discriminants and numeric bounds.
 */

/** Canonical request networks accepted at the redemption HTTP boundary. */
export const REDEMPTION_NETWORKS = [
  "ethereum",
  "base",
  "bnb",
  "bsc",
  "solana",
] as const;

export type RedemptionNetwork = (typeof REDEMPTION_NETWORKS)[number];
export type CanonicalRedemptionNetwork = Exclude<RedemptionNetwork, "bsc">;
export type RedemptionAsset = "eliza" | "usdc";

/**
 * Canonical stored unit for redeemable earnings is USD (NUMERIC(18,4)).
 * "Points" exist ONLY at this HTTP boundary: one USD is represented by 100
 * integer points (one point = $0.01). All SERVER-side conversions between the
 * two units go through `earnings-units.ts` (cloud-shared) — never recompute
 * the ratio inline. The browser UI keeps its dependency-free string parser
 * (same 100:1 ratio, its own tests). See issue #22960.
 */
export const REDEMPTION_POINTS_PER_USD = 100;
export const REDEMPTION_MIN_POINTS = 100;
export const REDEMPTION_MAX_POINTS = 100_000;
/** Current EVM requests above this threshold require a wallet proof. */
export const REDEMPTION_EVM_SIGNATURE_THRESHOLD_POINTS = 10_000;

export function canonicalizeRedemptionNetwork(
  network: RedemptionNetwork,
): CanonicalRedemptionNetwork {
  return network === "bsc" ? "bnb" : network;
}

export interface RedemptionQuoteRequest {
  /** Omitted requests preserve the public API's canonical $1 preview. */
  pointsAmount?: number;
  network: RedemptionNetwork;
}

export interface RedemptionQuote {
  /** GET /quote currently prices only the elizaOS-token payout flow. */
  asset: "eliza";
  network: CanonicalRedemptionNetwork;
  tokenAddress: string;
  pointsAmount: number;
  usdValue: number;
  twapPriceUsd: number;
  spotPriceUsd: number;
  priceMethod: "TWAP";
  elizaAmount: number;
  safetySpreadPercent: number;
  sampleCount: number;
  volatilityPercent: string;
  tokensAvailable: boolean;
  hotWalletBalance: number;
  validUntil: string;
  validitySeconds: number;
  requiresDelay: boolean;
  delayUntil?: string;
  requiresAdminApproval: boolean;
  limits: {
    minRedemptionUsd: number;
    maxRedemptionUsd: number;
    userDailyLimitUsd: number;
    userHourlyLimitUsd: number;
    largeRedemptionThresholdUsd: number;
    adminApprovalThresholdUsd: number;
  };
}

export interface RedemptionQuoteSuccessResponse {
  success: true;
  quote: RedemptionQuote;
  warnings?: string[];
  message: string;
  canRedeem: boolean;
}

export interface RedemptionQuoteErrorResponse {
  success: false;
  error: string;
  canRedeem?: false;
  availableNetworks?: CanonicalRedemptionNetwork[];
  suggestion?: string;
}

export type RedemptionQuoteResponse =
  | RedemptionQuoteSuccessResponse
  | RedemptionQuoteErrorResponse;

export interface CreateRedemptionRequest {
  appId?: string;
  pointsAmount: number;
  network: RedemptionNetwork;
  /**
   * Payout asset. The historical raw HTTP/SDK contract defaults omission to
   * `"usdc"`; quote-coupled callers should always send the quote's asset.
   * @default "usdc"
   */
  asset?: RedemptionAsset;
  payoutAddress: string;
  signature?: string;
  idempotencyKey?: string;
}

/** Stronger request used by flows that must correlate an explicit quote asset. */
export type ExplicitCreateRedemptionRequest = Omit<
  CreateRedemptionRequest,
  "asset"
> & {
  asset: RedemptionAsset;
};

export interface CreatedRedemptionQuote {
  pointsAmount: number;
  usdValue: string;
  elizaPriceUsd: string;
  elizaAmount: string;
  asset: RedemptionAsset;
  network: CanonicalRedemptionNetwork;
  payoutAddress: string;
  expiresAt: string;
  requiresReview: boolean;
}

export interface CreateRedemptionSuccessResponse {
  success: true;
  redemptionId: string;
  quote?: CreatedRedemptionQuote;
  warnings?: string[];
  message: string;
}

export interface CreateRedemptionErrorResponse {
  success: false;
  error: string;
}

export type CreateRedemptionResponse =
  | CreateRedemptionSuccessResponse
  | CreateRedemptionErrorResponse;

export interface RedemptionListItem {
  id: string;
  pointsAmount: number;
  usdValue: number;
  elizaAmount: number;
  elizaPriceUsd: number;
  asset: RedemptionAsset;
  network: CanonicalRedemptionNetwork;
  payoutAddress: string;
  status: string;
  txHash: string | null;
  createdAt: string;
  completedAt?: string;
  failureReason: string | null;
  requiresReview: boolean;
}

export interface ListRedemptionsResponse {
  success: true;
  redemptions: RedemptionListItem[];
  paused: boolean;
}

export interface RedemptionNetworkStatus {
  network: CanonicalRedemptionNetwork;
  available: boolean;
  status: string;
  message?: string;
  balance: number;
  balanceAvailable?: boolean;
}

export interface RedemptionStatusResponse {
  success: true;
  operational: boolean;
  canRedeem: boolean;
  message: string;
  availableNetworks: CanonicalRedemptionNetwork[];
  unavailableNetworks: CanonicalRedemptionNetwork[];
  wallets: {
    evm: { configured: boolean; address?: string };
    solana: { configured: boolean; address?: string };
  };
  networks: RedemptionNetworkStatus[];
  warnings: string[];
  lastChecked: string;
}
