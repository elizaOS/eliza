// @stwd/shared/types/venue
//
// Trading venues that Sol (and future agents) can be scoped to. A venue is
// the trading surface, not the chain: Hyperliquid orders are signed via
// EIP-712 but settle on its own L1; Polymarket is on Polygon but uses CTF
// plus a CLOB; Drift is a Solana program. The vault scopes wallets per
// venue so the same agent can hold distinct keys per trading surface.
//
// String union (not enum) because:
//   1. Drizzle pg-enums need migrations to extend; a TS union is free to
//      add new entries without touching SQL.
//   2. JSON-serialisable across worker boundaries with no runtime cost.
//   3. The DB stores `venue` as TEXT, validated at the application layer.
//
// When adding a new venue:
//   - Append to VENUE_IDS below.
//   - Add a row to VENUE_METADATA with chainFamily + display name.
//   - Worker A's adapter registry will pick it up automatically.

export const VENUE_IDS = [
  "hyperliquid",
  "polymarket",
  "drift",
  "aevo",
  "gmx",
] as const;

export type VenueId = (typeof VENUE_IDS)[number];

export function isVenueId(value: string): value is VenueId {
  return (VENUE_IDS as readonly string[]).includes(value);
}

export interface VenueMetadata {
  id: VenueId;
  displayName: string;
  /** Chain family of the signing key. EVM venues sign EIP-712 typed data. */
  chainFamily: "evm" | "solana";
  /** Underlying settlement chain CAIP-2 id, where applicable. */
  settlementCaip2?: string;
  /** True if the venue supports leveraged perpetuals. */
  supportsLeverage: boolean;
}

export const VENUE_METADATA: Record<VenueId, VenueMetadata> = {
  hyperliquid: {
    id: "hyperliquid",
    displayName: "Hyperliquid",
    chainFamily: "evm",
    settlementCaip2: "eip155:42161", // EVM signing, HL settlement
    supportsLeverage: true,
  },
  polymarket: {
    id: "polymarket",
    displayName: "Polymarket",
    chainFamily: "evm",
    settlementCaip2: "eip155:137",
    supportsLeverage: false,
  },
  drift: {
    id: "drift",
    displayName: "Drift",
    chainFamily: "solana",
    settlementCaip2: "solana:mainnet",
    supportsLeverage: true,
  },
  aevo: {
    id: "aevo",
    displayName: "Aevo",
    chainFamily: "evm",
    settlementCaip2: "eip155:42161",
    supportsLeverage: true,
  },
  gmx: {
    id: "gmx",
    displayName: "GMX",
    chainFamily: "evm",
    settlementCaip2: "eip155:42161",
    supportsLeverage: true,
  },
};

// ─── Sprint 4 Day 1-2 (Worker A): trade execution types ─────────────────────
// TradeAsset is the asset enum that venue-hyperliquid + trade-sessions use.
// Keep tight: only assets Steward will actively support for perps trading.

export type TradeAsset = "BTC" | "ETH";

export interface TradePolicyContext {
  venue: VenueId;
  asset: TradeAsset;
  leverage: number;
  size: number;
  sizeUsd?: number;
}
