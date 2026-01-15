export { checkOrderScoringAction } from "./checkOrderScoring";
export { retrieveAllMarketsAction } from "./getMarkets";
export { getOrderDetailsAction } from "./getOrderDetails";
export { getTokenInfoAction } from "./getTokenInfo";
export { getOrderBookDepthAction } from "./orderBook";
export { placeOrderAction } from "./placeOrder";
export { researchMarketAction } from "./researchMarket";

// =============================================================================
// Removed / Consolidated Actions
// =============================================================================

// The following actions have been removed and consolidated:

// Search Markets Action (consolidated into retrieveAllMarketsAction):
// - searchMarketsAction
// The unified POLYMARKET_GET_MARKETS action now handles both:
// - Keyword searches (e.g., "find miami heat markets")
// - Category browsing (e.g., "show sports markets")
// It uses the Gamma API for better data quality and freshness.

// Account State Actions (now in service/provider):
// - getBalancesAction
// - getActiveOrdersAction
// - getAccountAccessStatusAction
// - getTradeHistoryAction
// - getPositionsAction
// These are now automatically cached by PolymarketService and provided via polymarketProvider.
// The service refreshes this data on startup and every 30 minutes (TTL).
// Order scoring status is also included for active orders.

// Token Info Actions (consolidated into getTokenInfoAction):
// - getMarketDetailsAction
// - getPriceHistoryAction
// - getOrderBookSummaryAction
// Use getTokenInfoAction for comprehensive single-token information including:
// - Market details (question, category, status)
// - Current pricing (best bid/ask, spread, midpoint)
// - 24h price history summary
// - User position and active orders for the token
