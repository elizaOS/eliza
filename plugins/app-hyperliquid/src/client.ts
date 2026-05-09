import { ElizaClient } from "@elizaos/app-core";
import type {
  HyperliquidMarketsResponse,
  HyperliquidOrdersResponse,
  HyperliquidPositionsResponse,
  HyperliquidStatusResponse,
} from "./hyperliquid-contracts";

declare module "@elizaos/app-core" {
  interface ElizaClient {
    hyperliquidStatus(): Promise<HyperliquidStatusResponse>;
    hyperliquidMarkets(): Promise<HyperliquidMarketsResponse>;
    hyperliquidPositions(): Promise<HyperliquidPositionsResponse>;
    hyperliquidOrders(): Promise<HyperliquidOrdersResponse>;
  }
}

ElizaClient.prototype.hyperliquidStatus = async function () {
  return this.fetch("/api/hyperliquid/status");
};

ElizaClient.prototype.hyperliquidMarkets = async function () {
  return this.fetch("/api/hyperliquid/markets");
};

ElizaClient.prototype.hyperliquidPositions = async function () {
  return this.fetch("/api/hyperliquid/positions");
};

ElizaClient.prototype.hyperliquidOrders = async function () {
  return this.fetch("/api/hyperliquid/orders");
};
