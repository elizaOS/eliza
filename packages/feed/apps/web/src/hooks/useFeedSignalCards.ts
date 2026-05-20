"use client";

import { useEffect, useMemo } from "react";
import type {
  TopGainerProps,
  TopLoserProps,
} from "@/components/notifications/FeedSignalCards";
import { useAuth } from "@/hooks/useAuth";
import { useUserPositions } from "@/hooks/useUserPositions";

const CAP_STATE_KEY = "bab_feed_signal_cap";

interface FeedSignalCapState {
  date: string; // YYYY-MM-DD — resets daily
  shownGainerIds: string[];
  shownLoserIds: string[];
}

function getTodayDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function readCapState(): FeedSignalCapState {
  const today = getTodayDate();
  const empty: FeedSignalCapState = {
    date: today,
    shownGainerIds: [],
    shownLoserIds: [],
  };

  if (typeof window === "undefined") return empty;

  try {
    const stored = localStorage.getItem(CAP_STATE_KEY);
    if (!stored) return empty;
    const parsed = JSON.parse(stored) as FeedSignalCapState;
    return parsed.date === today ? parsed : empty;
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
  type: "gainer" | "loser",
  marketId: string,
): FeedSignalCapState {
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
  /** Always null until backend exposes closesAt on positions (TODO BAB-285) */
  closingCard: null;
}

interface DerivedFeedSignalCards {
  gainerCard: TopGainerProps | null;
  loserCard: TopLoserProps | null;
  closingCard: null;
  /** Updated cap state to persist, or null if no new cards were selected. */
  pendingCapState: FeedSignalCapState | null;
}

/**
 * Derives feed signal cards (top gainer / top loser) from the user's open
 * prediction positions. Applies daily capping and dedup via localStorage so
 * the same market is not surfaced more than once per day per card type.
 *
 * `closingCard` is always null — blocked on backend exposing `closesAt`.
 * TODO(BAB-285): enable MarketClosingSoonCard when closesAt is available on positions.
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
    let gainerCard: TopGainerProps | null = null;
    let loserCard: TopLoserProps | null = null;

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
      closingCard: null,
      // Only carry the updated state when new cards were selected
      pendingCapState: gainerCard || loserCard ? capState : null,
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
