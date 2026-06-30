export type UiTheme = "light" | "dark";

/**
 * User-selectable theme mode. `system` follows the OS `prefers-color-scheme`
 * and resolves to a concrete {@link UiTheme} at apply time. This is the
 * default for new users.
 */
export type UiThemeMode = "light" | "dark" | "system";

export type UiShellMode = "native";

/**
 * How the unified app background is rendered. `shader` paints the animated
 * warm-glow field in a user-chosen color; `image` paints a cover image the
 * user uploaded or generated.
 */
export type BackgroundMode = "shader" | "image";

/**
 * The user's chosen home/app background. It is read once at the shell root and
 * shared (unchanged) across the home and every view, so navigating never
 * remounts or flashes it. Individual apps/views may paint over it.
 */
export interface BackgroundConfig {
  mode: BackgroundMode;
  /** Base color for the shader field (6-digit hex, e.g. "#ef5a1f"). */
  color: string;
  /** Cover-image source (data URL or `/api/media/…`) when `mode === "image"`. */
  imageUrl?: string;
}

/** The default shader color — preserves the prior warm-orange home look. */
export const DEFAULT_BACKGROUND_COLOR = "#ef5a1f";

export const DEFAULT_BACKGROUND_CONFIG: BackgroundConfig = {
  mode: "shader",
  color: DEFAULT_BACKGROUND_COLOR,
};

/** A named default background — a curated shader color the user can pick. */
export interface BackgroundPreset {
  /** Stable slug used by chat ("use the green background") and tests. */
  id: string;
  /** Human-readable name shown to screen readers and the agent. */
  label: string;
  /** 6-digit hex color driving the shader field. */
  color: string;
}

/**
 * The curated default backgrounds. This is the single source of truth shared by
 * the Background view (swatches) and the agent's BACKGROUND action (so "use the
 * green background" maps to the same color the swatch sets). Each preset is a
 * live, breathing shader field — not a flat fill.
 */
export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  { id: "orange", label: "Orange", color: DEFAULT_BACKGROUND_COLOR },
  { id: "amber", label: "Amber", color: "#f59e0b" },
  { id: "rose", label: "Rose", color: "#e11d48" },
  { id: "red", label: "Red", color: "#dc2626" },
  { id: "green", label: "Green", color: "#059669" },
  { id: "olive", label: "Olive", color: "#65a30d" },
  { id: "stone", label: "Stone", color: "#57534e" },
  { id: "graphite", label: "Graphite", color: "#3f3f46" },
  { id: "black", label: "Black", color: "#0a0a0a" },
  { id: "light", label: "Light", color: "#f4f4f5" },
];

/** Structural equality for two background configs (skips history no-ops). */
export function backgroundConfigsEqual(
  a: BackgroundConfig,
  b: BackgroundConfig,
): boolean {
  return (
    a.mode === b.mode &&
    a.color === b.color &&
    (a.imageUrl ?? "") === (b.imageUrl ?? "")
  );
}
