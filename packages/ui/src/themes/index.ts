/**
 * Theme system — public API.
 *
 * Theme runtime (presets + DOM apply engine) was relocated here in Phase 5B
 * (`@elizaos/shared` shrink). The theme TYPE contract still lives in
 * `@elizaos/core/contracts/theme` because `shared/contracts/content-pack`
 * references `ThemeDefinition` and is itself consumed by this package — a
 * `shared → ui → shared` cycle would close if we moved the contract too.
 */
export { type ThemeColorSet, type ThemeDefinition, type ThemeFonts, type ThemeValidationError } from "@elizaos/core/contracts/theme";
export { THEME_CSS_VAR_MAP, THEME_CSS_VAR_NAMES, THEME_FONT_CSS_VARS, THEME_FONT_LINK_ID, validateThemeDefinition } from "@elizaos/core/contracts/theme";
export * from "./apply-theme.js";
export { ELIZA_DEFAULT_THEME } from "./presets.js";
