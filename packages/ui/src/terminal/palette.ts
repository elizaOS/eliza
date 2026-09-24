/**
 * Accent and status color tokens for CLI / terminal-adjacent UI theming.
 *
 * `CLI_PALETTE` is the single source of hex values for accent, info, success,
 * warn, error, and muted terminal output. Keep in sync with the CLI palette
 * section of `docs/cli/index.md`.
 */
export const CLI_PALETTE = {
  accent: "#FF5A2D",
  accentBright: "#FF7A3D",
  accentDim: "#D14A22",
  info: "#FF8A5B",
  success: "#2FBF71",
  warn: "#FFB020",
  error: "#E23D2D",
  muted: "#8B7F77",
} as const;
