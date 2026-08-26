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

/** Dark-glass recipes used by wallpaper-mounted shell chrome. */
export const WALLPAPER_GLASS = {
  notificationCenter:
    "border border-white/55 bg-black/35 text-white backdrop-blur-md supports-[backdrop-filter]:bg-black/30",
  menuPanel: "border border-white/14 bg-black/85",
  menuStatus: "border border-white/12 bg-black/85",
  menuWarning: "border border-amber-400/25 bg-black/85",
  // Chat-native: message text floats directly on the overlay's shared panel
  // glass — no per-message fill and no hairline box; row alignment + the float
  // shadow carry the user/assistant distinction (#13560 de-slop).
  messageBubble: "text-white",
  // Launcher-native scale of the chat composer's smoked glass: enough of the
  // wallpaper survives to tint each squircle, while the neutral blur, quiet
  // rim, and inset light keep a repeated icon grid calmer than ten pale cards.
  // Hover lifts only the graphite tone; keyboard focus uses the existing
  // orange accent as a thin rim. Neither state moves or scales the icon.
  launcherIcon:
    "relative border border-white/24 bg-[rgba(16,17,20,0.68)] text-white backdrop-blur-[18px] group-hover:bg-[rgba(28,29,32,0.74)] group-focus-visible:border-[var(--accent)] group-focus-visible:bg-[rgba(28,29,32,0.78)] !shadow-[inset_0_1px_0_rgba(255,255,255,0.30),inset_0_-1px_0_rgba(255,255,255,0.08),inset_0_-18px_34px_-28px_rgba(0,0,0,0.42)] before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:bg-[radial-gradient(120%_60%_at_30%_-10%,rgba(255,255,255,0.14)_0%,transparent_55%)] before:content-['']",
  floatingControl: "bg-black/55 text-white hover:bg-black/70",
} as const;
