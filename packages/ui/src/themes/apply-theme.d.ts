/**
 * Theme application engine.
 *
 * Applies a ThemeDefinition to the document root by setting CSS custom
 * properties. Works with the existing Tailwind @theme inline mapping
 * in styles.css — changing CSS vars automatically updates Tailwind tokens.
 */
import { type ThemeDefinition } from "@elizaos/shared";
/**
 * Apply a theme's color set for the given mode to the document root.
 * Returns a cleanup function that removes all applied properties.
 */
export declare function applyThemeToDocument(
  theme: ThemeDefinition,
  mode: "light" | "dark",
): () => void;
/**
 * Remove all theme-applied CSS custom properties from the document root,
 * restoring base.css defaults.
 */
export declare function clearThemeOverrides(): void;
//# sourceMappingURL=apply-theme.d.ts.map
