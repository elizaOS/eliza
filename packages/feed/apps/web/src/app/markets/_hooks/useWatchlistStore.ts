"use client";

import { useMemo } from "react";
import { useMarketWatchlistStore } from "@/stores/marketWatchlistStore";

/**
 * Backwards-compatible perps-only watchlist hook.
 *
 * Legacy perps UI expects a ticker-only API. The unified terminal uses a
 * cross-market watchlist store; this hook wraps it for perps.
 */
export function useWatchlistStore() {
  const favorites = useMarketWatchlistStore((s) => s.favorites);
  const toggleFavoriteKey = useMarketWatchlistStore((s) => s.toggleFavorite);
  const isFavoriteKey = useMarketWatchlistStore((s) => s.isFavorite);
  const clear = useMarketWatchlistStore((s) => s.clear);

  const perpFavorites = useMemo(
    () =>
      favorites.flatMap((key) => {
        const [kind, id] = key.split(":");
        if (kind !== "perp") return [];
        if (!id) return [];
        return [id];
      }),
    [favorites],
  );

  return useMemo(
    () => ({
      favorites: perpFavorites,
      toggleFavorite: (ticker: string) =>
        toggleFavoriteKey({ kind: "perp", id: ticker }),
      isFavorite: (ticker: string) =>
        isFavoriteKey({ kind: "perp", id: ticker }),
      clear,
    }),
    [perpFavorites, toggleFavoriteKey, isFavoriteKey, clear],
  );
}
