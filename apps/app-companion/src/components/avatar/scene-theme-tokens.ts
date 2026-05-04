/**
 * Theme-aware design tokens for Canvas2D scene overlay rendering.
 *
 * Canvas2D cannot read CSS variables directly, so we read computed
 * values from the document root at call time, with hardcoded fallbacks
 * for SSR / off-screen contexts.
 */

function css(prop: string, fallback: string): string {
  const readComputedStyle = globalThis.getComputedStyle;
  if (
    typeof document === "undefined" ||
    typeof readComputedStyle !== "function"
  ) {
    return fallback;
  }
  return (
    readComputedStyle(document.documentElement).getPropertyValue(prop).trim() ||
    fallback
  );
}

function cssWithAlpha(prop: string, alpha: number, fallback: string): string {
  const raw = css(prop, "");
  if (!raw) return fallback;
  // Wrap in rgb()/hsl() alpha if it looks like a hex or keyword
  if (raw.startsWith("#")) {
    const r = parseInt(raw.slice(1, 3), 16);
    const g = parseInt(raw.slice(3, 5), 16);
    const b = parseInt(raw.slice(5, 7), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return fallback;
}

/** Read current theme tokens for canvas rendering. Call once per paint. */
export function getSceneTokens() {
  return {
    accent: css("--status-info", "#3a7bd5"),
    accentBorder: cssWithAlpha("--status-info", 0.3, "rgba(58, 123, 213, 0.3)"),
    bgPanel: cssWithAlpha("--card", 0.82, "rgba(255, 255, 255, 0.82)"),
    bgCard: cssWithAlpha("--bg-accent", 0.75, "rgba(240, 243, 248, 0.75)"),
    textPrimary: css("--text", "#1a1a2e"),
    textSecondary: cssWithAlpha("--text", 0.6, "rgba(26, 26, 46, 0.6)"),
    textMuted: cssWithAlpha("--text", 0.35, "rgba(26, 26, 46, 0.35)"),
    statusGreen: css("--ok", "#10b981"),
    statusRed: css("--danger", "#ef4444"),
    statusYellow: css("--warn", "#f59e0b"),
    statusBlue: css("--status-info", "#3b82f6"),
    fontSans: css("--font-body", '"DM Sans", "Inter", sans-serif'),
    fontMono: css("--mono", '"JetBrains Mono", "Fira Code", monospace'),
    cornerRadius: 16,
  } as const;
}

export type SceneTokens = ReturnType<typeof getSceneTokens>;
