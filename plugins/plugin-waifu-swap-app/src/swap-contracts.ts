/**
 * Typed contract for the waifu.fun PancakeSwap v3 swap capability.
 *
 * Mirrors the on-chain adapter spec in
 * `packages/agent-actions/src/adapters/pancakeswap-v3/spec.ts`
 * (`pancakeV3Spec`) and the generic capability dispatch route in
 * `apps/api/src/routes/v2/agents/capability-actions.ts`
 * (`POST /v2/agents/:id/capabilities/:capabilitySlug/actions/:actionSlug`).
 * Kept as a standalone module so this app-plugin owns its own surface area and
 * never imports from the waifu monorepo.
 *
 * Capability shape (from `capabilityFromAdapterSpec(pancakeV3Spec)`):
 *
 *   capabilitySlug: "pancakeswap-v3"
 *   actions:
 *     - "quote"  mode=read          (estimate exact-input output, no consent)
 *     - "swap"   mode=agent_signed  (requiresConsent; on-chain write)
 *
 * Backend reality (as of this build): the generic action route exists, but the
 * `pancakeswap-v3:*` handlers are NOT yet registered in that route's HANDLERS
 * map (only `hyperliquid-perps:*` is). So both `quote` and `swap` currently
 * resolve to HTTP 501 "not yet available". This view therefore:
 *   - drives its displayed quote from a LOCAL estimate (price-driven), and
 *   - probes the real `quote` endpoint opportunistically, falling back to the
 *     local estimate when the backend returns 501, and
 *   - hard-STUBS `swap` execution behind a consent guard until the backend
 *     handler + agent signer land (see SWAP_EXECUTE_TODO).
 */

/**
 * EVM address literal. Defined locally (rather than importing viem) so this
 * app-plugin's contract module stays dependency-free and self-contained.
 */
export type Address = `0x${string}`;

export const PANCAKE_V3_CAPABILITY_SLUG = "pancakeswap-v3";
export const PANCAKE_V3_QUOTE_ACTION_SLUG = "quote";
export const PANCAKE_V3_SWAP_ACTION_SLUG = "swap";

/** Wrapped BNB — the native-asset proxy used in PancakeSwap v3 routes. */
export const PANCAKE_V3_WBNB: Address =
  "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

/** PancakeSwap v3 fee tiers (in hundredths of a bip), from the adapter spec. */
export const PANCAKE_V3_FEE_TIERS = [100, 500, 2500, 10000] as const;
export type PancakeV3Fee = (typeof PANCAKE_V3_FEE_TIERS)[number];
export const DEFAULT_PANCAKE_V3_FEE: PancakeV3Fee = 2500;

/** Slippage presets surfaced as quick-select chips, plus the default. */
export const SLIPPAGE_PRESETS = [0.1, 0.5, 1, 3] as const;
export const DEFAULT_SLIPPAGE_PCT = 0.5;
export const MIN_SLIPPAGE_PCT = 0.01;
export const MAX_SLIPPAGE_PCT = 50;

/**
 * A swap-eligible token. `priceBnb` is the price of ONE whole token expressed
 * in BNB (matches the waifu frontend `TokenMetrics.priceBnb` convention) and is
 * what drives the local quote estimate when the backend quote is unavailable.
 */
export interface SwapToken {
  readonly address: Address;
  readonly symbol: string;
  readonly decimals: number;
  /** Price of 1 whole token in BNB. 1 for the native BNB/WBNB side. */
  readonly priceBnb: number;
  /** Optional remote logo for the token icon. */
  readonly logoUrl?: string;
  /** True for the native BNB / WBNB side of a pair. */
  readonly isNative?: boolean;
}

/** Direction-resolved quote, whether locally estimated or backend-sourced. */
export interface SwapQuote {
  readonly tokenIn: SwapToken;
  readonly tokenOut: SwapToken;
  /** Human amount of tokenIn the user is spending. */
  readonly amountIn: number;
  /** Expected human amount of tokenOut, before slippage. */
  readonly amountOut: number;
  /** Worst-case tokenOut after applying slippage. */
  readonly minAmountOut: number;
  /** Signed price-impact percentage (negative = unfavourable). */
  readonly priceImpactPct: number;
  /** Slippage tolerance the quote was computed against. */
  readonly slippagePct: number;
  /** Fee tier the route uses. */
  readonly fee: PancakeV3Fee;
  /** Where the numbers came from: a local estimate or the live backend quote. */
  readonly source: "local-estimate" | "backend";
}

/** Request body for the generic capability `quote`/`swap` action. */
export interface SwapActionInput {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  fee?: PancakeV3Fee;
  /** Worst-case output (wei or human, backend-defined) — sent for `swap`. */
  minAmountOut?: string;
  /** Explicit consent flag the consent-gated `swap` action requires. */
  consent?: boolean;
}

/**
 * Backend `quote` (read mode) response. The generic route returns the handler's
 * raw body; for the pancakeswap-v3 quote the expected success shape carries the
 * exact-output amount. Optional fields tolerate the handler not being wired yet.
 */
export interface SwapQuoteResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  data?: {
    amountOut?: string | number;
    minAmountOut?: string | number;
    priceImpactPct?: string | number;
    fee?: number;
  };
}

/**
 * Backend `swap` (prepare_tx / client_signed) response: an UNSIGNED tx object
 * the patron signs in their own wallet. The server never holds the user key.
 * `agent_signed` swaps return 501 until the agent signer + policy land.
 */
export interface UnsignedSwapTx {
  to: Address;
  data: `0x${string}`;
  value: string;
  chainId?: number;
}

export interface SwapPrepareResponse {
  ok?: boolean;
  error?: string;
  message?: string;
  data?: {
    tx?: UnsignedSwapTx;
  };
}

/** Recognised failure kinds surfaced to the AppView so it can branch on status. */
export type SwapErrorKind =
  | "auth"
  | "consent-required"
  | "not-implemented"
  | "not-available"
  | "bad-request"
  | "misconfigured"
  | "unknown";

export interface SwapError {
  readonly kind: SwapErrorKind;
  readonly status: number;
  readonly message: string;
}

export function isSwapError(value: unknown): value is SwapError {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { status?: unknown }).status === "number"
  );
}

/** Map an HTTP status + message onto a typed {@link SwapError}. */
export function classifySwapStatus(status: number, message: string): SwapError {
  switch (status) {
    case 401:
      return { kind: "auth", status, message: "sign in to swap" };
    case 403:
      return {
        kind: "consent-required",
        status,
        message: "this swap requires explicit confirmation",
      };
    case 404:
      return {
        kind: "not-available",
        status,
        message: "swapping is not available for this agent",
      };
    case 400:
      return {
        kind: "bad-request",
        status,
        message: message || "invalid swap request",
      };
    case 501:
      return {
        kind: "not-implemented",
        status,
        message: "on-chain swap execution is not enabled yet",
      };
    case 503:
      return {
        kind: "misconfigured",
        status,
        message: "swapping is temporarily unavailable",
      };
    default:
      return {
        kind: "unknown",
        status,
        message: message || "swap failed",
      };
  }
}

/**
 * SWAP_EXECUTE_TODO — execution is intentionally stubbed.
 *
 * The PancakeSwap v3 `swap` action is `agent_signed` + `requiresConsent` in the
 * descriptor, and the generic capability route has NO `pancakeswap-v3:swap`
 * handler registered yet (it returns 501 NOT_IMPLEMENTED). Until the backend
 * handler returns either an unsigned tx (client_signed) or an agent-signer job,
 * this view must NOT fabricate a money path. `executeSwap()` is guarded so a
 * confirmed press surfaces a clear "not enabled yet" notice instead of POSTing
 * to a route that can't fulfil it. Flip {@link SWAP_EXECUTE_ENABLED} once the
 * backend handler lands and this contract's tx shape is confirmed.
 */
export const SWAP_EXECUTE_ENABLED = false as const;

/**
 * Compute a local exact-input quote from token prices. Used as the display
 * source whenever the backend `quote` handler is unavailable (501).
 *
 * `priceBnb` is the price of 1 whole token in BNB, so the BNB value of the
 * input equals `amountIn * tokenIn.priceBnb`, and the output token amount is
 * that BNB value divided by `tokenOut.priceBnb`. Price impact is modelled as a
 * mild, monotonic function of trade size (bounded) — a transparent placeholder
 * until the on-chain quoter is wired, matching the existing waifu swap panel's
 * local estimate behaviour.
 *
 * SAFETY: this is a CLIENT-SIDE PLACEHOLDER and is acceptable ONLY because
 * on-chain execution is disabled ({@link SWAP_EXECUTE_ENABLED} is false), so
 * these numbers are display-only and never settle a trade. Before anyone flips
 * execution on, the quote MUST move server-side to the real on-chain quoter
 * (with slippage/min-out enforced there); this function then degrades to a
 * fallback-only estimate, never the source of a settled minAmountOut.
 */
export function estimateLocalQuote(
  tokenIn: SwapToken,
  tokenOut: SwapToken,
  amountIn: number,
  slippagePct: number,
  fee: PancakeV3Fee,
): SwapQuote {
  const safeIn = Number.isFinite(amountIn) && amountIn > 0 ? amountIn : 0;
  const bnbValue = safeIn * tokenIn.priceBnb;
  const grossOut = tokenOut.priceBnb > 0 ? bnbValue / tokenOut.priceBnb : 0;

  // Bounded, size-sensitive impact placeholder (never worse than -5%).
  const priceImpactPct = safeIn > 0 ? -Math.min(5, bnbValue * 0.04) : 0;

  const impactAdjustedOut = grossOut * (1 + priceImpactPct / 100);
  const minAmountOut =
    impactAdjustedOut * (1 - clampSlippage(slippagePct) / 100);

  return {
    tokenIn,
    tokenOut,
    amountIn: safeIn,
    amountOut: impactAdjustedOut,
    minAmountOut: Math.max(0, minAmountOut),
    priceImpactPct,
    slippagePct: clampSlippage(slippagePct),
    fee,
    source: "local-estimate",
  };
}

/** Clamp a slippage percentage into the supported range. */
export function clampSlippage(pct: number): number {
  if (!Number.isFinite(pct)) return DEFAULT_SLIPPAGE_PCT;
  return Math.min(MAX_SLIPPAGE_PCT, Math.max(MIN_SLIPPAGE_PCT, pct));
}
