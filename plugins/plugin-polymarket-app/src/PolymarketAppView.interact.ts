// View-bundle `interact` capability handler, split out of PolymarketAppView.tsx
// so that file exports only React components and stays Fast-Refresh-compatible
// (Vite would full-reload a component file that also exports a plain function).
// The view bundle re-exports `interact` via ./polymarket-view-bundle.ts.
import { client } from "@elizaos/app-core";
import "./client";
import type { PolymarketClient } from "./client";
import {
  loadPolymarketTuiState,
  postPolymarketCommand,
} from "./PolymarketAppView.helpers";
import type { PolymarketOrderbookResponse } from "./polymarket-contracts";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-polymarket-state") {
    const user = typeof params?.user === "string" ? params.user.trim() : "";
    const state = await loadPolymarketTuiState(user || undefined);
    return {
      viewType: "tui",
      status: state.status,
      markets: state.markets.markets.slice(
        0,
        typeof params?.limit === "number" ? params.limit : 25,
      ),
      orders: state.orders,
      positions: state.positions,
    };
  }

  if (capability === "terminal-polymarket-market") {
    const id = typeof params?.id === "string" ? params.id.trim() : "";
    const slug = typeof params?.slug === "string" ? params.slug.trim() : "";
    const polymarketClient = client as PolymarketClient;
    if (id) {
      return {
        viewType: "tui",
        ...(await polymarketClient.polymarketMarketById(id)),
      };
    }
    if (slug) {
      return {
        viewType: "tui",
        ...(await polymarketClient.polymarketMarketBySlug(slug)),
      };
    }
    throw new Error("id or slug is required");
  }

  if (capability === "terminal-polymarket-orderbook") {
    const tokenId =
      typeof params?.tokenId === "string" ? params.tokenId.trim() : "";
    if (!tokenId) throw new Error("tokenId is required");
    const orderbook: PolymarketOrderbookResponse = await (
      client as PolymarketClient
    ).polymarketOrderbook(tokenId);
    return { viewType: "tui", orderbook };
  }

  if (capability === "terminal-polymarket-positions") {
    const user = typeof params?.user === "string" ? params.user.trim() : "";
    if (!user) throw new Error("user is required");
    return {
      viewType: "tui",
      positions: await (client as PolymarketClient).polymarketPositions(user),
    };
  }

  if (capability === "terminal-polymarket-trading-check") {
    return {
      viewType: "tui",
      result: await postPolymarketCommand("/api/polymarket/orders", {
        marketId: typeof params?.marketId === "string" ? params.marketId : "",
        side: typeof params?.side === "string" ? params.side : "buy",
        outcome: typeof params?.outcome === "string" ? params.outcome : "",
        size:
          typeof params?.size === "number" || typeof params?.size === "string"
            ? params.size
            : 0,
      }),
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
