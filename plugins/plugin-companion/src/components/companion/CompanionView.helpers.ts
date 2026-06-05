// Shared (non-component) helpers for the companion view. Kept out of
// CompanionView.tsx so that file exports only React components and stays
// Fast-Refresh-compatible. Used by both the view components and the view-bundle
// `interact` handler.

import { EMOTE_CATALOG, type EmoteCategory } from "../../emotes/catalog";

export function countByCategory(): Record<EmoteCategory, number> {
  return EMOTE_CATALOG.reduce<Record<EmoteCategory, number>>(
    (counts, emote) => {
      counts[emote.category] = (counts[emote.category] ?? 0) + 1;
      return counts;
    },
    {
      greeting: 0,
      emotion: 0,
      dance: 0,
      combat: 0,
      idle: 0,
      movement: 0,
      gesture: 0,
      other: 0,
    },
  );
}
