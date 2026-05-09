import { ElizaClient } from "@elizaos/ui";
import type {
  PolymarketDisabledResponse,
  PolymarketMarketResponse,
  PolymarketMarketsResponse,
  PolymarketOrderbookResponse,
  PolymarketPositionsResponse,
  PolymarketStatusResponse,
} from "./polymarket-contracts";

export interface PolymarketMarketsRequest {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
  order?: string;
  ascending?: boolean;
  tagId?: string;
}

declare module "@elizaos/ui" {
  interface ElizaClient {
    polymarketStatus(): Promise<PolymarketStatusResponse>;
    polymarketMarkets(
      request?: PolymarketMarketsRequest,
    ): Promise<PolymarketMarketsResponse>;
    polymarketMarketById(id: string): Promise<PolymarketMarketResponse>;
    polymarketMarketBySlug(slug: string): Promise<PolymarketMarketResponse>;
    polymarketOrderbook(tokenId: string): Promise<PolymarketOrderbookResponse>;
    polymarketOrders(): Promise<PolymarketDisabledResponse>;
    polymarketPositions(user: string): Promise<PolymarketPositionsResponse>;
  }
}

type PolymarketClientPrototype = ElizaClient & {
  polymarketStatus(): Promise<PolymarketStatusResponse>;
  polymarketMarkets(
    request?: PolymarketMarketsRequest,
  ): Promise<PolymarketMarketsResponse>;
  polymarketMarketById(id: string): Promise<PolymarketMarketResponse>;
  polymarketMarketBySlug(slug: string): Promise<PolymarketMarketResponse>;
  polymarketOrderbook(tokenId: string): Promise<PolymarketOrderbookResponse>;
  polymarketOrders(): Promise<PolymarketDisabledResponse>;
  polymarketPositions(user: string): Promise<PolymarketPositionsResponse>;
};

const elizaClientPrototype =
  ElizaClient.prototype as unknown as PolymarketClientPrototype;

elizaClientPrototype.polymarketStatus = async function () {
  return this.fetch("/api/polymarket/status");
};

elizaClientPrototype.polymarketMarkets = async function (
  request: PolymarketMarketsRequest = {},
) {
  const params = new URLSearchParams();
  appendParam(params, "limit", request.limit);
  appendParam(params, "offset", request.offset);
  appendParam(params, "active", request.active);
  appendParam(params, "closed", request.closed);
  appendParam(params, "order", request.order);
  appendParam(params, "ascending", request.ascending);
  appendParam(params, "tag_id", request.tagId);
  const query = params.toString();
  return this.fetch(`/api/polymarket/markets${query ? `?${query}` : ""}`);
};

elizaClientPrototype.polymarketMarketById = async function (id: string) {
  const params = new URLSearchParams({ id });
  return this.fetch(`/api/polymarket/market?${params.toString()}`);
};

elizaClientPrototype.polymarketMarketBySlug = async function (slug: string) {
  const params = new URLSearchParams({ slug });
  return this.fetch(`/api/polymarket/market?${params.toString()}`);
};

elizaClientPrototype.polymarketOrderbook = async function (tokenId: string) {
  const params = new URLSearchParams({ token_id: tokenId });
  return this.fetch(`/api/polymarket/orderbook?${params.toString()}`);
};

elizaClientPrototype.polymarketOrders = async function () {
  return this.fetch("/api/polymarket/orders");
};

elizaClientPrototype.polymarketPositions = async function (user: string) {
  const params = new URLSearchParams({ user });
  return this.fetch(`/api/polymarket/positions?${params.toString()}`);
};

function appendParam(
  params: URLSearchParams,
  key: string,
  value: string | number | boolean | undefined,
): void {
  if (value === undefined) return;
  params.set(key, String(value));
}
