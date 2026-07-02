/**
 * shader-schema — the typed, validated uniform contract for the programmable
 * GLSL background (#10694).
 *
 * Arbitrary GLSL is untrusted GPU code and the uniform values arrive from
 * untrusted places (the agent, persisted localStorage, chat). Everything here
 * coerces those inputs into a safe, finite, clamped shape so a hostile or
 * malformed value can never NaN the render or push the GPU into a hang. This
 * module is deliberately three.js-free so it unit-tests without a WebGL context.
 */

/** The tunable uniforms the user/agent can drive. Standard `u_time` /
 * `u_resolution` are injected by the renderer and are NOT part of this set. */
export interface ShaderUniformValues {
  /** Animation rate multiplier. */
  u_speed: number;
  /** Spatial frequency / zoom of the pattern. */
  u_scale: number;
  /** Brightness / contrast multiplier. */
  u_intensity: number;
  /** Variation seed (also the frozen phase under reduced-motion). */
  u_seed: number;
}

export const SHADER_UNIFORM_KEYS: ReadonlyArray<keyof ShaderUniformValues> = [
  "u_speed",
  "u_scale",
  "u_intensity",
  "u_seed",
];

interface UniformSpec {
  min: number;
  max: number;
  default: number;
}

/**
 * Single source of truth for the tunable-uniform ranges. The clamp bounds ARE
 * the safety contract: nothing outside these ever reaches the shader.
 */
export const UNIFORM_SCHEMA: Record<keyof ShaderUniformValues, UniformSpec> = {
  u_speed: { min: 0, max: 3, default: 1 },
  u_scale: { min: 0.1, max: 6, default: 1 },
  u_intensity: { min: 0, max: 2, default: 1 },
  u_seed: { min: 0, max: 1000, default: 0 },
};

export const DEFAULT_SHADER_UNIFORMS: ShaderUniformValues = {
  u_speed: UNIFORM_SCHEMA.u_speed.default,
  u_scale: UNIFORM_SCHEMA.u_scale.default,
  u_intensity: UNIFORM_SCHEMA.u_intensity.default,
  u_seed: UNIFORM_SCHEMA.u_seed.default,
};

function clampOne(value: unknown, spec: UniformSpec): number {
  const n =
    typeof value === "number" && Number.isFinite(value) ? value : spec.default;
  return Math.min(spec.max, Math.max(spec.min, n));
}

/**
 * Coerce an unknown record (persisted config, agent payload) into a fully
 * populated, clamped uniform set. Missing/invalid keys fall back to defaults.
 */
export function normalizeUniforms(value: unknown): ShaderUniformValues {
  const r =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    u_speed: clampOne(r.u_speed, UNIFORM_SCHEMA.u_speed),
    u_scale: clampOne(r.u_scale, UNIFORM_SCHEMA.u_scale),
    u_intensity: clampOne(r.u_intensity, UNIFORM_SCHEMA.u_intensity),
    u_seed: clampOne(r.u_seed, UNIFORM_SCHEMA.u_seed),
  };
}

/** Merge a partial uniform patch onto a base, re-clamping the result. */
export function mergeUniforms(
  base: ShaderUniformValues,
  patch: Partial<Record<keyof ShaderUniformValues, unknown>> | undefined,
): ShaderUniformValues {
  if (!patch) return normalizeUniforms(base);
  return normalizeUniforms({ ...base, ...patch });
}

/** Structural equality for two uniform sets (history no-op detection). */
export function uniformsEqual(
  a: ShaderUniformValues,
  b: ShaderUniformValues,
): boolean {
  return (
    a.u_speed === b.u_speed &&
    a.u_scale === b.u_scale &&
    a.u_intensity === b.u_intensity &&
    a.u_seed === b.u_seed
  );
}

/** `#rrggbb` (validated upstream) → linear `[r,g,b]` in [0,1]. Defaults to the
 * brand orange on a malformed hex so u_color is always finite. */
export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(
    typeof hex === "string" ? hex.trim() : "",
  );
  const h = m ? m[1] : "ef5a1f";
  return [
    Number.parseInt(h.slice(0, 2), 16) / 255,
    Number.parseInt(h.slice(2, 4), 16) / 255,
    Number.parseInt(h.slice(4, 6), 16) / 255,
  ];
}

/** Max accepted fragment-source size — a huge source is rejected before it ever
 * reaches the GPU compiler. */
export const MAX_SHADER_SOURCE_BYTES = 16 * 1024;

/**
 * Cheap static safety gate applied BEFORE the authoritative GL compile-validate
 * in the renderer. Bounds the size and rejects the one construct a hang-prone
 * shader needs (`while` — an unbounded GPU loop). Preset shaders use bounded
 * `for` loops only, so this never rejects a legitimate background.
 */
export function isPlausibleFragmentSource(source: unknown): source is string {
  if (typeof source !== "string") return false;
  if (source.length === 0 || source.length > MAX_SHADER_SOURCE_BYTES)
    return false;
  // Must actually write an output.
  if (
    !source.includes("gl_FragColor") &&
    !source.includes("pc_fragColor") &&
    !/\bout\s+vec4\b/.test(source)
  ) {
    return false;
  }
  // `while`/`do` can spin unbounded on the GPU — reject (presets use bounded for).
  if (/\bwhile\b/.test(source) || /\bdo\b/.test(source)) return false;
  return true;
}
