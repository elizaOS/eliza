"use client";

import { useEffect, useMemo } from "react";
import type {
  MarketClosingSoonProps,
  TopGainerProps,
  TopLoserProps,
} from "@/components/notifications/FeedSignalCards";
import { useAuth } from "@/hooks/useAuth";
import { useUserPositions } from "@/hooks/useUserPositions";

const CAP_STATE_KEY = "bab_feed_signal_cap";

interface FeedSignalCapState {
  date: string; // YYYY-MM-DD — resets daily
  shownClosingIds: string[];
  shownGainerIds: string[];
  shownLoserIds: string[];
}

const CLOSING_SOON_WINDOW_MS = 24 * 60 * 60 * 1000;

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function readCapState(): FeedSignalCapState {
  const today = getTodayDate();
  const empty: FeedSignalCapState = {
    date: today,
    shownClosingIds: [],
    shownGainerIds: [],
    shownLoserIds: [],
  };

  if (typeof window === "undefined") return empty;

  try {
    const stored = localStorage.getItem(CAP_STATE_KEY);
    if (!stored) return empty;
    const parsed = JSON.parse(stored) as FeedSignalCapState;
    if (parsed.date !== today) return empty;
    return {
      date: parsed.date,
      shownClosingIds: parsed.shownClosingIds ?? [],
      shownGainerIds: parsed.shownGainerIds ?? [],
      shownLoserIds: parsed.shownLoserIds ?? [],
    };
  } catch {
    return empty;
  }
}

function writeCapState(state: FeedSignalCapState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(CAP_STATE_KEY, JSON.stringify(state));
  } catch {
    // Ignore storage quota / private-mode errors
  }
}

function markShown(
  state: FeedSignalCapState,
  type: "closing" | "gainer" | "loser",
  marketId: string,
): FeedSignalCapState {
  if (type === "closing") {
    if (state.shownClosingIds.includes(marketId)) return state;
    return { ...state, shownClosingIds: [...state.shownClosingIds, marketId] };
  }
  if (type === "gainer") {
    if (state.shownGainerIds.includes(marketId)) return state;
    return { ...state, shownGainerIds: [...state.shownGainerIds, marketId] };
  }
  if (state.shownLoserIds.includes(marketId)) return state;
  return { ...state, shownLoserIds: [...state.shownLoserIds, marketId] };
}

export interface FeedSignalCardsResult {
  gainerCard: TopGainerProps | null;
  loserCard: TopLoserProps | null;
  closingCard: MarketClosingSoonProps | null;
}

interface DerivedFeedSignalCards {
  gainerCard: TopGainerProps | null;
  loserCard: TopLoserProps | null;
  closingCard: MarketClosingSoonProps | null;
  /** Updated cap state to persist, or null if no new cards were selected. */
  pendingCapState: FeedSignalCapState | null;
}

/**
 * Derives feed signal cards from the user's open prediction positions. Applies
 * daily capping and dedup via localStorage so the same market is not surfaced
 * more than once per day per card type.
 */
export function useFeedSignalCards(): FeedSignalCardsResult {
  const { user } = useAuth();
  const { predictionPositions } = useUserPositions(user?.id ?? null);

  // Pure derivation — no side effects. localStorage write happens in the effect below.
  const derived = useMemo((): DerivedFeedSignalCards => {
    const noCards: DerivedFeedSignalCards = {
      gainerCard: null,
      loserCard: null,
      closingCard: null,
      pendingCapState: null,
    };

    if (!predictionPositions || predictionPositions.length === 0)
      return noCards;

    // Only consider active, unresolved positions with non-zero cost basis
    const active = predictionPositions.filter(
      (p) => !p.resolved && p.costBasis > 0,
    );
    if (active.length === 0) return noCards;

    // Sort by unrealizedPnL descending: best gainer first, worst loser last
    const sorted = [...active].sort(
      (a, b) => b.unrealizedPnL - a.unrealizedPnL,
    );

    let capState = readCapState();
    let closingCard: MarketClosingSoonProps | null = null;
    let gainerCard: TopGainerProps | null = null;
    let loserCard: TopLoserProps | null = null;

    const now = Date.now();
    const closingCandidates = active
      .map((pos) => ({
        pos,
        closeTime: pos.closesAt ? new Date(pos.closesAt).getTime() : Number.NaN,
      }))
      .filter(({ closeTime }) => {
        if (!Number.isFinite(closeTime)) return false;
        const msUntilClose = closeTime - now;
        return msUntilClose > 0 && msUntilClose <= CLOSING_SOON_WINDOW_MS;
      })
      .sort((a, b) => a.closeTime - b.closeTime);

    for (const { pos } of closingCandidates) {
      if (!pos.closesAt) continue;
      if (!capState.shownClosingIds.includes(pos.marketId)) {
        closingCard = {
          marketId: pos.marketId,
          marketName: pos.question,
          closesAt: pos.closesAt,
          positionSide: pos.side,
          currentPrice: pos.currentPrice,
          entryPrice: pos.avgPrice,
        };
        capState = markShown(capState, "closing", pos.marketId);
        break;
      }
    }

    // Top gainer: first position with positive PnL not already shown today
    for (const pos of sorted) {
      if (pos.unrealizedPnL <= 0) break;
      if (!capState.shownGainerIds.includes(pos.marketId)) {
        const gainPercent = (pos.unrealizedPnL / pos.costBasis) * 100;
        gainerCard = {
          marketId: pos.marketId,
          marketName: pos.question,
          pointsGained: Math.round(pos.unrealizedPnL),
          gainPercent,
          agentName: pos.agentName,
        };
        capState = markShown(capState, "gainer", pos.marketId);
        break;
      }
    }

    // Top loser: last position with negative PnL not already shown today
    for (let i = sorted.length - 1; i >= 0; i--) {
      const pos = sorted[i]!;
      if (pos.unrealizedPnL >= 0) break;
      if (!capState.shownLoserIds.includes(pos.marketId)) {
        const lossPercent = (Math.abs(pos.unrealizedPnL) / pos.costBasis) * 100;
        loserCard = {
          marketId: pos.marketId,
          marketName: pos.question,
          pointsLost: Math.round(pos.unrealizedPnL),
          lossPercent,
          agentName: pos.agentName,
        };
        capState = markShown(capState, "loser", pos.marketId);
        break;
      }
    }

    return {
      gainerCard,
      loserCard,
      closingCard,
      // Only carry the updated state when new cards were selected
      pendingCapState: closingCard || gainerCard || loserCard ? capState : null,
    };
  }, [predictionPositions]);

  // Persist cap state after commit — safe for concurrent/aborted renders and Strict Mode.
  useEffect(() => {
    if (derived.pendingCapState) {
      writeCapState(derived.pendingCapState);
    }
  }, [derived.pendingCapState]);

  return {
    gainerCard: derived.gainerCard,
    loserCard: derived.loserCard,
    closingCard: derived.closingCard,
  };
}
