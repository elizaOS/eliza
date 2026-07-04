// Maps plugin/builtin view ids that have NO dedicated baked icon onto the
// closest bundled icon key, so every launcher view resolves to a proper image
// instead of the generic `default` glyph. These plugin view ids
// (`registerAppShellPage` ids) differ from their nearest baked-icon key, e.g.
// the Hyperliquid plugin registers `hyperliquid` but the trading icon is baked
// as `trade`.
//
// This lives OUTSIDE `view-icons.generated.ts` (which the icon bake overwrites)
// so the alias map survives icon regeneration. Ids that already have their own
// baked icon (e.g. `feed`, `facewear`, `polymarket`) are intentionally absent —
// they resolve directly.
export const VIEW_ICON_ALIASES: Record<string, string> = {
  hyperliquid: "trade",
  shopify: "shop",
  smartglasses: "glasses",
  "trajectory-logger": "trajectory",
  "phone-companion": "companion",
  // Character-family views promoted out of the old Character hub reuse the
  // nearest baked icons (no dedicated art baked for these ids yet).
  "character-skills": "skills",
  experience: "memories",
};

/**
 * Resolve a view/app id to the id whose baked icon should represent it. Returns
 * the id unchanged when it has (or should fall back from) its own icon.
 */
export function resolveViewIconId(id: string): string {
  return VIEW_ICON_ALIASES[id] ?? id;
}
