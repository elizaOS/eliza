/**
 * @elizaos/plugin-polymarket Actions
 *
 * Re-export all Polymarket actions.
 */

export { checkOrderScoringAction } from "./checkOrderScoring";
// API key management actions
export { createApiKeyAction } from "./createApiKey";
export { getAccountAccessStatusAction } from "./getAccountAccessStatus";
export { getActiveOrdersAction } from "./getActiveOrders";
export { getAllApiKeysAction } from "./getAllApiKeys";
// Additional market actions
export { getClobMarketsAction } from "./getClobMarkets";
// Market actions
export {
  getMarketDetailsAction,
  getSamplingMarketsAction,
  getSimplifiedMarketsAction,
  retrieveAllMarketsAction,
} from "./getMarkets";
export { getOpenMarketsAction } from "./getOpenMarkets";
export { getOrderDetailsAction } from "./getOrderDetails";
export { getPriceHistoryAction } from "./getPriceHistory";
export { getTradeHistoryAction } from "./getTradeHistory";
export { handleAuthenticationAction } from "./handleAuthentication";
export { handleRealtimeUpdatesAction } from "./handleRealtimeUpdates";
// Order book actions
export {
  getBestPriceAction,
  getMidpointPriceAction,
  getOrderBookDepthAction,
  getOrderBookSummaryAction,
  getSpreadAction,
} from "./orderBook";
// Order placement and management actions
export { placeOrderAction } from "./placeOrder";
export { revokeApiKeyAction } from "./revokeApiKey";
// WebSocket and real-time actions
export { setupWebsocketAction } from "./setupWebsocket";
