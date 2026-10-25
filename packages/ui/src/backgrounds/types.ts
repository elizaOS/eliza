/**
 * Solid background color used as the static fallback when the theme's
 * `--background` CSS variable is unavailable (e.g. before stylesheets load).
 * Brand rule (#8796): no blue — a light neutral matches the light theme bg
 * without flashing a blue frame before the stylesheet loads.
 */
export const SKY_BACKGROUND_COLOR = "#f4f4f5";

/**
 * CSS value for the static shell background. Prefers the theme's
 * `--background` token and falls back to the solid sky color.
 */
export const SOLID_BACKGROUND_CSS = `var(--background, ${SKY_BACKGROUND_COLOR})`;
