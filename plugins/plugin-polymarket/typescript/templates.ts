import {
  checkOrderScoringTemplate,
  getBestPriceTemplate,
  getMarketTemplate,
  getMidpointPriceTemplate,
  getOrderBookDepthTemplate,
  getOrderBookTemplate,
  getOrderDetailsTemplate,
  getPriceHistoryTemplate,
  getSamplingMarketsTemplate,
  getSimplifiedMarketsTemplate,
  getSpreadTemplate,
  orderTemplate,
  retrieveAllMarketsTemplate,
  setupWebsocketTemplate,
  researchMarketTemplate,
} from "./generated/prompts/typescript/prompts";

export {
  retrieveAllMarketsTemplate,
  getSimplifiedMarketsTemplate,
  getSamplingMarketsTemplate,
  getMarketTemplate,
  orderTemplate,
  getOrderBookTemplate,
  getOrderBookDepthTemplate,
  getBestPriceTemplate,
  getMidpointPriceTemplate,
  getSpreadTemplate,
  getOrderDetailsTemplate,
  getPriceHistoryTemplate,
  checkOrderScoringTemplate,
  setupWebsocketTemplate,
  researchMarketTemplate,
};

// Note: getActiveOrdersTemplate, getTradeHistoryTemplate, and getAccountAccessStatusTemplate
// are no longer exported as these actions have been removed. Account state is now
// automatically cached by the PolymarketService and provided via the provider.
