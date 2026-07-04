/**
 * Types and defaults for persisted UI preferences — theme mode (light/dark/
 * system), shell mode, and the app background config (shader uniforms, image).
 * Owned by useDisplayPreferences; persisted to localStorage.
 */
export type UiTheme = "light" | "dark";

/**
 * User-selectable theme mode. `system` follows the OS `prefers-color-scheme`
 * and resolves to a concrete {@link UiTheme} at apply time. This is the
 * default for new users.
 */
export type UiThemeMode = "light" | "dark" | "system";

export type UiShellMode = "native";

import {
  DEFAULT_SHADER_UNIFORMS,
  normalizeUniforms,
  type ShaderUniformValues,
  uniformsEqual,
} from "../backgrounds/shader-schema";

/**
 * How the unified app background is rendered. `shader` paints the animated
 * warm-glow field in a user-chosen color; `image` paints a cover image the
 * user uploaded or generated; `glsl` runs an arbitrary programmable GLSL
 * fragment shader (#10694) with typed, clamped uniforms.
 */
export type BackgroundMode = "shader" | "image" | "glsl";

/** A programmable GLSL background: a fragment shader + its tunable uniforms. */
export interface ShaderConfig {
  /** Preset id when the source came from the library (for the picker/label). */
  presetId?: string;
  /** GLSL ES 1.00 fragment source. */
  source: string;
  /** Tunable uniform values (validated + clamped). */
  uniforms: ShaderUniformValues;
}

/**
 * The user's chosen home/app background. It is read once at the shell root and
 * shared (unchanged) across the home and every view, so navigating never
 * remounts or flashes it. Individual apps/views may paint over it.
 */
export interface BackgroundConfig {
  mode: BackgroundMode;
  /** Base color for the shader field / `u_color` (6-digit hex, e.g. "#ef5a1f"). */
  color: string;
  /** Cover-image source (data URL or `/api/media/…`) when `mode === "image"`. */
  imageUrl?: string;
  /** Programmable shader + uniforms when `mode === "glsl"`. */
  shader?: ShaderConfig;
}

/** The default shader color — preserves the prior warm-orange home look. */
export const DEFAULT_BACKGROUND_COLOR = "#ef5a1f";

/**
 * The ember glow hue the shader layers over {@link DEFAULT_BACKGROUND_COLOR}:
 * the warm orange that gives the dark field its banked-fire warmth without
 * becoming the field itself. Matches the brand accent (`#ff6a1f`). The shader
 * pools this glow low near the composer, so the field reads as a banked ember
 * rather than a flat color wall.
 */
export const DEFAULT_BACKGROUND_GLOW = "#ff6a1f";

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
    (a.imageUrl ?? "") === (b.imageUrl ?? "") &&
    shaderConfigsEqual(a.shader, b.shader)
  );
}

function shaderConfigsEqual(a?: ShaderConfig, b?: ShaderConfig): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.source === b.source &&
    (a.presetId ?? "") === (b.presetId ?? "") &&
    uniformsEqual(a.uniforms, b.uniforms)
  );
}

/* ── Accent color presets ─────────────────────────────────────────────── */

/**
 * The default accent id — keeps the app's built-in brand accent (orange) by
 * applying no `--accent` override, so base.css / the host brand theme wins.
 */
export const DEFAULT_ACCENT_ID = "default";

/**
 * A named accent color the user can pick for the app's `--accent` token. The
 * `default` preset carries `color: null` (clears the override → brand accent).
 * Kept to the app's curated warm/neutral palette — never blue (brand rule
 * #8796).
 */
export interface AccentPreset {
  /** Stable slug persisted + used by onboarding + Appearance settings. */
  id: string;
  /** Human-readable name shown on the swatch and to screen readers. */
  label: string;
  /**
   * 6-digit hex applied to `--accent` (+ derived tokens), or `null` for the
   * built-in brand accent.
   */
  color: string | null;
  /** Emoji swatch used where only text labels render (in-chat onboarding). */
  swatch: string;
}

/**
 * The curated accent choices. Single source of truth shared by the Appearance
 * settings swatches and the first-run onboarding accent step, so both drive the
 * exact same persisted preference.
 */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "default", label: "Eliza Orange", color: null, swatch: "🟠" },
  { id: "amber", label: "Amber", color: "#f59e0b", swatch: "🟡" },
  { id: "rose", label: "Rose", color: "#e11d48", swatch: "🌹" },
  { id: "red", label: "Red", color: "#dc2626", swatch: "🔴" },
  { id: "green", label: "Green", color: "#059669", swatch: "🟢" },
  { id: "olive", label: "Olive", color: "#65a30d", swatch: "🫒" },
];

/** Coerce an unknown persisted value to a valid accent id (default fallback). */
export function normalizeAccentId(value: unknown): string {
  return typeof value === "string" && ACCENT_PRESETS.some((p) => p.id === value)
    ? value
    : DEFAULT_ACCENT_ID;
}

/**
 * Resolve an accent id to its hex color, or `null` for the built-in brand
 * accent (the `default` preset, or any unknown id).
 */
export function resolveAccentColor(id: string): string | null {
  return ACCENT_PRESETS.find((p) => p.id === id)?.color ?? null;
}

/** Build a normalized glsl `BackgroundConfig` from a shader source + partials.
 * `uniforms` accepts unknown-valued partials (agent/persisted input);
 * `normalizeUniforms` clamps + coerces them to finite numbers. */
export function makeGlslConfig(args: {
  source: string;
  color?: string;
  presetId?: string;
  uniforms?: Partial<Record<keyof ShaderUniformValues, unknown>>;
}): BackgroundConfig {
  return {
    mode: "glsl",
    color: args.color ?? DEFAULT_BACKGROUND_COLOR,
    shader: {
      presetId: args.presetId,
      source: args.source,
      uniforms: normalizeUniforms({
        ...DEFAULT_SHADER_UNIFORMS,
        ...(args.uniforms ?? {}),
      }),
    },
  };
}
