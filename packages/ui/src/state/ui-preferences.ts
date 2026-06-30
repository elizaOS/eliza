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

/**
 * The default shader base: a warm near-black field (NOT a saturated orange
 * wall). The home reads as a banked ember in a dark room, a deep brown-black
 * substrate the orange glow breathes against, so content stays legible and the
 * accent stays an accent. The old default (#ef5a1f) flooded the whole viewport
 * with bright orange and washed every surface out.
 */
export const DEFAULT_BACKGROUND_COLOR = "#160d07";

/**
 * The ember glow hue layered over {@link DEFAULT_BACKGROUND_COLOR} by the
 * shader: the warm orange that gives the dark field its banked-fire warmth
 * without becoming the field itself. Matches the brand accent.
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
  { id: "ember", label: "Ember", color: DEFAULT_BACKGROUND_COLOR },
  { id: "amber", label: "Amber", color: "#1a120a" },
  { id: "rose", label: "Rose", color: "#190b0f" },
  { id: "plum", label: "Plum", color: "#140b14" },
  { id: "forest", label: "Forest", color: "#0b1410" },
  { id: "olive", label: "Olive", color: "#11130a" },
  { id: "stone", label: "Stone", color: "#16140f" },
  { id: "graphite", label: "Graphite", color: "#101013" },
  { id: "ink", label: "Ink", color: "#0a0a0c" },
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
