/**
 * shader-presets — the named GLSL fragment-shader library for the programmable
 * background (#10694). Each preset is self-contained GLSL ES 1.00 that:
 *   - declares `precision highp float;`
 *   - reads the injected `u_time` / `u_resolution` and the tunable
 *     `u_color` / `u_speed` / `u_scale` / `u_intensity` / `u_seed` uniforms,
 *   - writes `gl_FragColor` with alpha 1.0,
 *   - is finite for every uv in [0,1] and every clamped uniform value, and
 *   - uses only bounded `for` loops (never `while`) so it cannot hang the GPU.
 *
 * The agent names a preset ("give me a lava background"); the renderer resolves
 * the id → source here. The action never ships GLSL text, so the shader corpus
 * lives entirely in the renderer.
 */

import type { ShaderUniformValues } from "./shader-schema";

export interface ShaderPreset {
  /** Stable slug used by chat + the settings picker + tests. */
  id: string;
  /** Human-readable name (screen readers + the agent reply). */
  label: string;
  /** GLSL ES 1.00 fragment source. */
  source: string;
  /** Per-preset uniform defaults layered over the schema defaults. */
  defaults: Partial<ShaderUniformValues>;
}

// Shared value-noise + fbm helper, prepended to presets that need organic
// motion. Bounded loops only.
const NOISE_LIB = `
vec2 hash2(vec2 p){p=vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3)));return -1.0+2.0*fract(sin(p)*43758.5453123);}
float vnoise(vec2 p){vec2 i=floor(p);vec2 f=fract(p);vec2 u=f*f*(3.0-2.0*f);return mix(mix(dot(hash2(i),f),dot(hash2(i+vec2(1.0,0.0)),f-vec2(1.0,0.0)),u.x),mix(dot(hash2(i+vec2(0.0,1.0)),f-vec2(0.0,1.0)),dot(hash2(i+vec2(1.0,1.0)),f-vec2(1.0,1.0)),u.x),u.y);}
float fbm(vec2 p){float v=0.0;float a=0.5;for(int i=0;i<5;i++){v+=a*vnoise(p);p*=2.02;a*=0.5;}return v;}
`;

const HEAD = `precision highp float;
uniform float u_time;
uniform vec2 u_resolution;
uniform vec3 u_color;
uniform float u_speed;
uniform float u_scale;
uniform float u_intensity;
uniform float u_seed;
`;

const AURORA = `${HEAD}${NOISE_LIB}
void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * 0.15 * u_speed + u_seed;
  float band = fbm(vec2(uv.x * u_scale * 2.0, uv.y * 0.6 - t));
  float glow = smoothstep(0.1, 0.9, band + uv.y * 0.4);
  vec3 col = u_color * glow * 1.4 * u_intensity + u_color * 0.15;
  gl_FragColor = vec4(col, 1.0);
}`;

const LAVA = `${HEAD}${NOISE_LIB}
void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * 0.2 * u_speed + u_seed;
  float n = fbm(uv * u_scale * 3.0 + vec2(t, -t * 0.5));
  n += 0.5 * fbm(uv * u_scale * 6.0 - vec2(t * 0.3));
  float glow = pow(clamp(n, 0.0, 1.0), 1.5);
  vec3 col = mix(u_color * 0.2, u_color * 1.6, glow) * u_intensity;
  gl_FragColor = vec4(col, 1.0);
}`;

const PLASMA = `${HEAD}
void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * 0.5 * u_speed + u_seed;
  float s = u_scale * 4.0;
  float v = sin(uv.x * s + t) + sin(uv.y * s + t * 1.3)
          + sin((uv.x + uv.y) * s * 0.7 + t * 0.7)
          + sin(length(uv - 0.5) * s * 1.5 - t);
  float f = 0.5 + 0.25 * v;
  vec3 col = u_color * (0.4 + 0.8 * f) * u_intensity;
  gl_FragColor = vec4(col, 1.0);
}`;

const WAVES = `${HEAD}
void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * 0.4 * u_speed + u_seed;
  float w = sin(uv.x * u_scale * 6.2831 + t) * 0.05
          + sin(uv.x * u_scale * 3.14159 - t * 0.7) * 0.03;
  float d = smoothstep(0.02, 0.0, abs(uv.y - 0.5 - w));
  float field = 0.35 + 0.4 * uv.y;
  vec3 col = u_color * (field + d * 0.6) * u_intensity;
  gl_FragColor = vec4(col, 1.0);
}`;

const NEBULA = `${HEAD}${NOISE_LIB}
void main(){
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  float t = u_time * 0.08 * u_speed + u_seed;
  float c = fbm(uv * u_scale * 2.5 + vec2(t, t * 0.6));
  c = smoothstep(0.2, 0.95, c);
  vec3 col = mix(u_color * 0.12, u_color * 1.3, c) * u_intensity;
  gl_FragColor = vec4(col, 1.0);
}`;

export const SHADER_PRESETS: readonly ShaderPreset[] = [
  {
    id: "aurora",
    label: "Aurora",
    source: AURORA,
    defaults: { u_speed: 1.0, u_scale: 1.0 },
  },
  {
    id: "lava",
    label: "Lava",
    source: LAVA,
    defaults: { u_speed: 1.0, u_scale: 1.0 },
  },
  {
    id: "plasma",
    label: "Plasma",
    source: PLASMA,
    defaults: { u_speed: 1.0, u_scale: 1.0 },
  },
  {
    id: "waves",
    label: "Waves",
    source: WAVES,
    defaults: { u_speed: 1.0, u_scale: 1.0 },
  },
  {
    id: "nebula",
    label: "Nebula",
    source: NEBULA,
    defaults: { u_speed: 0.8, u_scale: 1.0 },
  },
];

export const DEFAULT_SHADER_PRESET_ID = "aurora";

/** Resolve a preset by id (case-insensitive). Returns undefined if unknown. */
export function getShaderPreset(
  id: string | undefined,
): ShaderPreset | undefined {
  if (!id) return undefined;
  const lower = id.toLowerCase();
  return SHADER_PRESETS.find((p) => p.id === lower);
}
