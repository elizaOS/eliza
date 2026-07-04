/**
 * Unit coverage for shader uniform parsing/validation and fragment-source safety
 * (size cap, plausibility). Pure functions, no GPU.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHADER_UNIFORMS,
  hexToRgb,
  isPlausibleFragmentSource,
  MAX_SHADER_SOURCE_BYTES,
  mergeUniforms,
  normalizeUniforms,
  UNIFORM_SCHEMA,
  uniformsEqual,
} from "./shader-schema";

describe("shader-schema — uniform normalization + clamping", () => {
  it("fills every key from a partial/empty input with schema defaults", () => {
    expect(normalizeUniforms({})).toEqual(DEFAULT_SHADER_UNIFORMS);
    expect(normalizeUniforms(undefined)).toEqual(DEFAULT_SHADER_UNIFORMS);
    expect(normalizeUniforms(null)).toEqual(DEFAULT_SHADER_UNIFORMS);
    expect(normalizeUniforms("nope")).toEqual(DEFAULT_SHADER_UNIFORMS);
  });

  it("clamps out-of-range values to the schema bounds (safety contract)", () => {
    const hostile = normalizeUniforms({
      u_speed: 9999,
      u_scale: -50,
      u_intensity: 100,
      u_seed: 1e9,
    });
    expect(hostile.u_speed).toBe(UNIFORM_SCHEMA.u_speed.max);
    expect(hostile.u_scale).toBe(UNIFORM_SCHEMA.u_scale.min);
    expect(hostile.u_intensity).toBe(UNIFORM_SCHEMA.u_intensity.max);
    expect(hostile.u_seed).toBe(UNIFORM_SCHEMA.u_seed.max);
  });

  it("replaces non-finite values (NaN / Infinity / non-number) with defaults", () => {
    const u = normalizeUniforms({
      u_speed: Number.NaN,
      u_scale: Number.POSITIVE_INFINITY,
      u_intensity: "1.5",
      u_seed: {},
    });
    expect(u.u_speed).toBe(UNIFORM_SCHEMA.u_speed.default);
    expect(u.u_scale).toBe(UNIFORM_SCHEMA.u_scale.default);
    expect(u.u_intensity).toBe(UNIFORM_SCHEMA.u_intensity.default);
    expect(u.u_seed).toBe(UNIFORM_SCHEMA.u_seed.default);
  });

  it("keeps valid in-range values", () => {
    const u = normalizeUniforms({
      u_speed: 1.5,
      u_scale: 2,
      u_intensity: 0.5,
      u_seed: 42,
    });
    expect(u).toEqual({
      u_speed: 1.5,
      u_scale: 2,
      u_intensity: 0.5,
      u_seed: 42,
    });
  });

  it("mergeUniforms overlays a patch and re-clamps", () => {
    const base = normalizeUniforms({
      u_speed: 1,
      u_scale: 1,
      u_intensity: 1,
      u_seed: 0,
    });
    const merged = mergeUniforms(base, { u_speed: 99 });
    expect(merged.u_speed).toBe(UNIFORM_SCHEMA.u_speed.max);
    expect(merged.u_scale).toBe(1);
    expect(mergeUniforms(base, undefined)).toEqual(base);
  });

  it("uniformsEqual is structural", () => {
    const a = normalizeUniforms({
      u_speed: 1,
      u_scale: 1,
      u_intensity: 1,
      u_seed: 0,
    });
    expect(uniformsEqual(a, { ...a })).toBe(true);
    expect(uniformsEqual(a, { ...a, u_speed: 2 })).toBe(false);
  });
});

describe("shader-schema — hexToRgb", () => {
  it("parses #rrggbb to [0,1] triples", () => {
    expect(hexToRgb("#ffffff")).toEqual([1, 1, 1]);
    expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    const [r, g, b] = hexToRgb("#ef5a1f");
    expect(r).toBeCloseTo(0xef / 255);
    expect(g).toBeCloseTo(0x5a / 255);
    expect(b).toBeCloseTo(0x1f / 255);
  });
  it("tolerates a missing # and defaults on garbage (always finite)", () => {
    expect(hexToRgb("ef5a1f")).toEqual(hexToRgb("#ef5a1f"));
    for (const bad of ["", "#xyz", "red", "#12", "#1234567"]) {
      const rgb = hexToRgb(bad);
      expect(rgb).toHaveLength(3);
      for (const c of rgb) expect(Number.isFinite(c)).toBe(true);
    }
  });
});

describe("shader-schema — isPlausibleFragmentSource (static safety gate)", () => {
  const good =
    "precision highp float; void main(){ gl_FragColor = vec4(1.0); }";
  it("accepts a plausible fragment that writes an output", () => {
    expect(isPlausibleFragmentSource(good)).toBe(true);
    expect(
      isPlausibleFragmentSource(
        "precision highp float; out vec4 o; void main(){ o = vec4(1.0); }",
      ),
    ).toBe(true);
  });
  it("rejects non-strings, empty, and oversized sources", () => {
    expect(isPlausibleFragmentSource(undefined)).toBe(false);
    expect(isPlausibleFragmentSource(123)).toBe(false);
    expect(isPlausibleFragmentSource("")).toBe(false);
    expect(
      isPlausibleFragmentSource("x".repeat(MAX_SHADER_SOURCE_BYTES + 1)),
    ).toBe(false);
  });
  it("rejects sources with no output write", () => {
    expect(
      isPlausibleFragmentSource(
        "precision highp float; void main(){ float x = 1.0; }",
      ),
    ).toBe(false);
  });
  it("rejects unbounded loops (GPU-hang guard)", () => {
    expect(
      isPlausibleFragmentSource(
        "void main(){ while(true){} gl_FragColor = vec4(1.0); }",
      ),
    ).toBe(false);
    expect(
      isPlausibleFragmentSource(
        "void main(){ do { } while(true); gl_FragColor = vec4(1.0); }",
      ),
    ).toBe(false);
  });
});
