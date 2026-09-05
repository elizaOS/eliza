export interface TradePolicySession {
  venue?: string;
  allowedVenues?: readonly string[];
  leverageCap?: number;
  allowedAssets?: readonly string[];
  allowBuilderPerps?: boolean;
  dailySpendUsd?: number;
  dailyCapUsd?: number;
  perOrderCapUsd?: number;
}

export interface TradeOrderPolicyInput {
  venue?: string;
  asset?: string;
  leverage?: number;
  estimatedOrderUsd?: number;
}

export interface TradeOrderEvaluation {
  allow: boolean;
  reason?: string;
}

export type TradeOrderEvaluator = (
  session: TradePolicySession,
  order: TradeOrderPolicyInput,
) => TradeOrderEvaluation;

const DEFAULT_LEVERAGE_CAP = 2;
const DEFAULT_ALLOWED_ASSETS = ["BTC", "ETH"] as const;
const DEFAULT_PER_ORDER_CAP_USD = 50;
const BUILDER_PERP_LEVERAGE_CAP = 3;
const BUILDER_PERP_SYMBOL_RE = /^[a-z0-9]+:[A-Z0-9]+$/;
function isBuilderPerpAsset(asset: string | undefined): boolean {
  return typeof asset === "string" && BUILDER_PERP_SYMBOL_RE.test(asset);
}

function finitePositiveOrderUsd(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

export const venueAllowlistEvaluator: TradeOrderEvaluator = (
  session,
  order,
) => {
  const allowed =
    session.allowedVenues ?? (session.venue ? [session.venue] : []);
  if (allowed.length === 0) {
    return {
      allow: false,
      reason: "venue-allowlist: no venues are allowed for this session",
    };
  }
  if (!order.venue) {
    return { allow: false, reason: "venue-allowlist: order venue is missing" };
  }
  if (!allowed.includes(order.venue)) {
    return {
      allow: false,
      reason: `venue-allowlist: venue ${order.venue} is not allowed for this session`,
    };
  }
  return { allow: true };
};

export const leverageCapEvaluator: TradeOrderEvaluator = (session, order) => {
  if (
    session.leverageCap !== undefined &&
    (!Number.isFinite(session.leverageCap) || session.leverageCap < 1)
  ) {
    return {
      allow: false,
      reason: "leverage-cap: session leverage cap is invalid",
    };
  }
  const sessionCap = session.leverageCap ?? DEFAULT_LEVERAGE_CAP;
  const cap = isBuilderPerpAsset(order.asset)
    ? Math.min(sessionCap, BUILDER_PERP_LEVERAGE_CAP)
    : sessionCap;
  if (
    order.leverage !== undefined &&
    (!Number.isFinite(order.leverage) || order.leverage < 1)
  ) {
    return {
      allow: false,
      reason: "leverage-cap: requested leverage is invalid",
    };
  }
  const leverage = order.leverage ?? 1;
  if (leverage > cap) {
    return {
      allow: false,
      reason: `leverage-cap: leverage ${leverage} exceeds cap ${cap}`,
    };
  }
  return { allow: true };
};

export const assetAllowlistEvaluator: TradeOrderEvaluator = (
  session,
  order,
) => {
  const allowed = session.allowedAssets ?? DEFAULT_ALLOWED_ASSETS;
  if (allowed.length === 0) {
    return {
      allow: false,
      reason: "asset-allowlist: no assets are allowed for this session",
    };
  }
  if (!order.asset) {
    return { allow: false, reason: "asset-allowlist: order asset is missing" };
  }
  if (isBuilderPerpAsset(order.asset) && session.allowBuilderPerps !== true) {
    return {
      allow: false,
      reason: `builder-perp: builder perp ${order.asset} requires allowBuilderPerps policy opt-in`,
    };
  }
  if (!allowed.includes(order.asset)) {
    return {
      allow: false,
      reason: `asset-allowlist: asset ${order.asset} is not allowed for this session`,
    };
  }
  return { allow: true };
};

export const dailySpendCapEvaluator: TradeOrderEvaluator = (session, order) => {
  const dailyCapUsd = session.dailyCapUsd;
  if (dailyCapUsd === undefined) return { allow: true };
  if (!Number.isFinite(dailyCapUsd) || dailyCapUsd < 0) {
    return {
      allow: false,
      reason: "daily-spend-cap: session daily cap is invalid",
    };
  }
  if (
    session.dailySpendUsd !== undefined &&
    (!Number.isFinite(session.dailySpendUsd) || session.dailySpendUsd < 0)
  ) {
    return {
      allow: false,
      reason: "daily-spend-cap: session daily spend is invalid",
    };
  }
  const spent = session.dailySpendUsd ?? 0;
  const estimated = finitePositiveOrderUsd(order.estimatedOrderUsd);
  if (estimated === null) {
    return {
      allow: false,
      reason:
        "daily-spend-cap: estimated order USD is required when a daily cap is configured",
    };
  }
  if (spent + estimated > dailyCapUsd) {
    return {
      allow: false,
      reason: `daily-spend-cap: $${spent + estimated} would exceed daily cap $${dailyCapUsd}`,
    };
  }
  return { allow: true };
};

export const perOrderCapEvaluator: TradeOrderEvaluator = (session, order) => {
  if (
    session.perOrderCapUsd !== undefined &&
    (!Number.isFinite(session.perOrderCapUsd) || session.perOrderCapUsd <= 0)
  ) {
    return {
      allow: false,
      reason: "per-order-cap: session per-order cap is invalid",
    };
  }
  const cap = session.perOrderCapUsd ?? DEFAULT_PER_ORDER_CAP_USD;
  const estimated = finitePositiveOrderUsd(order.estimatedOrderUsd);
  if (estimated === null) {
    return {
      allow: false,
      reason:
        "per-order-cap: estimated order USD is required when a per-order cap is configured",
    };
  }
  if (estimated > cap) {
    return {
      allow: false,
      reason: `per-order-cap: order $${estimated} exceeds cap $${cap}`,
    };
  }
  return { allow: true };
};

export const defaultTradeOrderEvaluators: readonly TradeOrderEvaluator[] = [
  venueAllowlistEvaluator,
  assetAllowlistEvaluator,
  leverageCapEvaluator,
  perOrderCapEvaluator,
  dailySpendCapEvaluator,
];

export interface EvaluationResult extends TradeOrderEvaluation {
  failedEvaluator?: string;
}

export function evaluateTradeOrder(
  session: TradePolicySession,
  order: TradeOrderPolicyInput,
  evaluators: readonly TradeOrderEvaluator[] = defaultTradeOrderEvaluators,
): EvaluationResult {
  for (const evaluator of evaluators) {
    const result = evaluator(session, order);
    if (!result.allow) {
      return {
        ...result,
        failedEvaluator: evaluator.name || "anonymous-evaluator",
      };
    }
  }
  return { allow: true };
}
