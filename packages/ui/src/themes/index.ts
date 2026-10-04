/**
 * Theme presets and DOM application. Shared ThemeDefinition contracts live in
 * @elizaos/contracts so non-UI consumers do not depend on this package.
 */
export {
  THEME_CSS_VAR_MAP,
  THEME_CSS_VAR_NAMES,
  THEME_FONT_CSS_VARS,
  THEME_FONT_LINK_ID,
  type ThemeColorSet,
  type ThemeDefinition,
  type ThemeFonts,
  type ThemeValidationError,
  validateThemeDefinition,
} from "@elizaos/contracts";
export * from "./apply-theme.js";
export { ELIZA_DEFAULT_THEME } from "./presets.js";
