/**
 * Shared wallpaper-surface visual tokens.
 *
 * These classes are intentionally theme-independent: wallpaper surfaces sit on
 * the live ambient field instead of app chrome, so they use fixed white text,
 * dark glass washes, and a single float shadow for legibility over bright or
 * busy backgrounds.
 */

/** Floating text shadow for naked white-on-wallpaper text and glass rows. */
export const WALLPAPER_FLOAT_SHADOW = "[text-shadow:0_1px_4px_rgba(0,0,0,0.7)]";

/** Fixed light-text ladder for copy rendered directly over wallpaper. */
export const WALLPAPER_TEXT = {
  base: "text-white",
  strong: "text-white/95",
  primary: "text-white/85",
  secondary: "text-white/70",
  muted: "text-white/60",
  soft: "text-white/55",
  faint: "text-white/40",
  whisper: "text-white/35",
  danger: "text-red-200/90",
  warning: "text-amber-200/80",
} as const;
