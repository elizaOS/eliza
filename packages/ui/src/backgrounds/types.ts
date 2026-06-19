/**
 * Solid background color used as the static fallback when the theme's
 * `--background` CSS variable is unavailable (e.g. before stylesheets load).
 */
export const SKY_BACKGROUND_COLOR = "#1d91e8";

/**
 * CSS value for the static shell background. Prefers the theme's
 * `--background` token and falls back to the solid sky color.
 */
export const SOLID_BACKGROUND_CSS = `var(--background, ${SKY_BACKGROUND_COLOR})`;
