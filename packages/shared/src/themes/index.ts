/**
 * Theme system — public API.
 */

export type {
  ThemeColorSet,
  ThemeDefinition,
  ThemeFonts,
  ThemeValidationError,
} from "../contracts/theme.js";

export {
  THEME_CSS_VAR_MAP,
  THEME_CSS_VAR_NAMES,
  THEME_FONT_CSS_VARS,
  THEME_FONT_LINK_ID,
  validateThemeDefinition,
} from "../contracts/theme.js";
export { ELIZA_DEFAULT_THEME, ELIZA_DEFAULT_THEME } from "./presets.js";
