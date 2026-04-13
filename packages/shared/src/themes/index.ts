/**
 * Theme system — public API.
 */

export type {
  ThemeColorSet,
  ThemeDefinition,
  ThemeFonts,
  ThemeValidationError,
} from "../contracts/theme";

export {
  DEFAULT_THEME_ID,
  THEME_CSS_VAR_MAP,
  THEME_CSS_VAR_NAMES,
  THEME_FONT_CSS_VARS,
  THEME_FONT_LINK_ID,
  validateThemeDefinition,
} from "../contracts/theme";
export {
  BSC_GOLD_THEME,
  BUILTIN_THEMES,
  COMIC_POP_THEME,
  HACKER_TERMINAL_THEME,
  NEON_CYBER_THEME,
  RETRO_90S_THEME,
} from "./presets";
