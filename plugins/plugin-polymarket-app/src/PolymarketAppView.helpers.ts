// Shared data helpers for the Polymarket view, used by both PolymarketTuiView
// (in PolymarketAppView.tsx) and the `interact` capability handler
// (in PolymarketAppView.interact.ts). Kept out of the .tsx so that file exports
// only React components and stays Fast-Refresh-compatible in dev.
import { client } from "@elizaos/app-core";
import "./client";
import type { PolymarketClient } from "./client";
import type {
  PolymarketDisabledResponse,
  PolymarketMarketsResponse,
  PolymarketPositionsResponse,
  PolymarketStatusResponse,
} from "./polymarket-contracts";

export async function loadPolymarketTuiState(user?: string): Promise<{
  status: PolymarketStatusResponse;
  markets: PolymarketMarketsResponse;
  orders: PolymarketDisabledResponse;
  positions: PolymarketPositionsResponse | null;
}> {
  const polymarketClient = client as PolymarketClient;
  const [status, markets, orders] = await Promise.all([
    polymarketClient.polymarketStatus(),
    polymarketClient.polymarketMarkets({ limit: 25 }),
    polymarketClient.polymarketOrders(),
  ]);
  const positions = user
    ? await polymarketClient.polymarketPositions(user)
    : null;
  return { status, markets, orders, positions };
}

export async function postPolymarketCommand(
  path: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data !== null &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : `Polymarket request failed with ${response.status}`;
    throw new Error(message);
  }
  return data;
}
