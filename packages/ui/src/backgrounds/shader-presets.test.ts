/**
 * Unit coverage for the shader preset table and lookup. Pure data, no GPU.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHADER_PRESET_ID,
  getShaderPreset,
  SHADER_PRESETS,
} from "./shader-presets";
import { isPlausibleFragmentSource } from "./shader-schema";

describe("shader-presets library", () => {
  it("ships a non-empty library with unique ids", () => {
    expect(SHADER_PRESETS.length).toBeGreaterThanOrEqual(5);
    const ids = SHADER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("the default preset id resolves", () => {
    expect(getShaderPreset(DEFAULT_SHADER_PRESET_ID)).toBeDefined();
  });

  it.each(
    SHADER_PRESETS.map((p) => [p.id, p] as const),
  )("preset %s is a well-formed, safe fragment shader", (_id, preset) => {
    // Passes the static safety gate (has an output write, bounded, sized).
    expect(isPlausibleFragmentSource(preset.source)).toBe(true);
    // Declares precision + writes gl_FragColor with full alpha somewhere.
    expect(preset.source).toContain("precision highp float");
    expect(preset.source).toContain("gl_FragColor");
    // Reads the injected + tunable uniforms it is contracted to.
    for (const u of ["u_time", "u_resolution", "u_color"]) {
      expect(preset.source).toContain(u);
    }
    // No unbounded loops (GPU-hang guard) — bounded `for` only.
    expect(/\bwhile\b/.test(preset.source)).toBe(false);
    expect(/\bdo\b/.test(preset.source)).toBe(false);
    // Has a human label.
    expect(preset.label.length).toBeGreaterThan(0);
  });

  it("getShaderPreset is case-insensitive and returns undefined for unknown ids", () => {
    expect(getShaderPreset("LAVA")?.id).toBe("lava");
    expect(getShaderPreset("nope")).toBeUndefined();
    expect(getShaderPreset(undefined)).toBeUndefined();
  });
});
