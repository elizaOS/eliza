/**
 * Maps view IDs without dedicated baked artwork to the nearest stable icon.
 * The hand-authored aliases live outside the generated manifest so icon
 * regeneration cannot erase product-level mappings.
 */
export const VIEW_ICON_ALIASES: Record<string, string> = {
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
