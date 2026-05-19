import { ElizaClient } from "@elizaos/ui";
import type {
	HyperliquidMarketsResponse,
	HyperliquidOrdersResponse,
	HyperliquidPositionsResponse,
	HyperliquidStatusResponse,
} from "./hyperliquid-contracts";

export type HyperliquidClient = ElizaClient & {
	hyperliquidStatus(): Promise<HyperliquidStatusResponse>;
	hyperliquidMarkets(): Promise<HyperliquidMarketsResponse>;
	hyperliquidPositions(): Promise<HyperliquidPositionsResponse>;
	hyperliquidOrders(): Promise<HyperliquidOrdersResponse>;
};

const elizaClientPrototype =
	ElizaClient.prototype as unknown as HyperliquidClient;

elizaClientPrototype.hyperliquidStatus = async function () {
  return this.fetch("/api/hyperliquid/status");
};

elizaClientPrototype.hyperliquidMarkets = async function () {
  return this.fetch("/api/hyperliquid/markets");
};

elizaClientPrototype.hyperliquidPositions = async function () {
  return this.fetch("/api/hyperliquid/positions");
};

elizaClientPrototype.hyperliquidOrders = async function () {
  return this.fetch("/api/hyperliquid/orders");
};
