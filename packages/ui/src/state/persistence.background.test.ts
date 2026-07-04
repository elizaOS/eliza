// @vitest-environment jsdom
/**
 * Background-config persistence (`persistence`): load/save round-trip and
 * `normalizeBackgroundConfig` clamping of malformed stored values. jsdom + real
 * `localStorage`.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  loadBackgroundConfig,
  normalizeBackgroundConfig,
  saveBackgroundConfig,
} from "./persistence";
import { DEFAULT_BACKGROUND_COLOR } from "./ui-preferences";

const DEFAULT = { mode: "shader", color: DEFAULT_BACKGROUND_COLOR } as const;

afterEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

describe("background config persistence", () => {
  it("normalizes a valid shader config and lowercases the color", () => {
    expect(
      normalizeBackgroundConfig({ mode: "shader", color: "#AABBCC" }),
    ).toEqual({ mode: "shader", color: "#aabbcc" });
  });

  it("falls back to the default shader for unusable input", () => {
    expect(normalizeBackgroundConfig(null)).toEqual(DEFAULT);
    expect(normalizeBackgroundConfig("nope")).toEqual(DEFAULT);
    // image mode with no usable url collapses to the shader
    expect(normalizeBackgroundConfig({ mode: "image" })).toEqual(DEFAULT);
    // invalid color collapses to the default color
    expect(normalizeBackgroundConfig({ color: "red" })).toEqual(DEFAULT);
  });

  it("keeps an image config that carries a usable url", () => {
    expect(
      normalizeBackgroundConfig({
        mode: "image",
        color: "#123456",
        imageUrl: "/api/media/abc.png",
      }),
    ).toEqual({
      mode: "image",
      color: "#123456",
      imageUrl: "/api/media/abc.png",
    });
  });

  it("keeps a glsl config with a plausible fragment source and clamps its uniforms", () => {
    const source =
      "precision highp float; void main(){ gl_FragColor = vec4(1.0); }";
    expect(
      normalizeBackgroundConfig({
        mode: "glsl",
        color: "#123456",
        shader: {
          presetId: "lava",
          source,
          uniforms: { u_speed: 999, u_scale: 2, u_intensity: 1, u_seed: 5 },
        },
      }),
    ).toEqual({
      mode: "glsl",
      color: "#123456",
      shader: {
        presetId: "lava",
        source,
        // u_speed clamped from 999 → 3 (schema max); others kept.
        uniforms: { u_speed: 3, u_scale: 2, u_intensity: 1, u_seed: 5 },
      },
    });
  });

  it("collapses a glsl config with a missing/hostile source to the color field (safety)", () => {
    // no shader payload
    expect(
      normalizeBackgroundConfig({ mode: "glsl", color: "#123456" }),
    ).toEqual({
      mode: "shader",
      color: "#123456",
    });
    // unbounded-loop source is rejected by the static gate → color field
    expect(
      normalizeBackgroundConfig({
        mode: "glsl",
        color: "#123456",
        shader: {
          source: "void main(){ while(true){} gl_FragColor=vec4(1.0);}",
        },
      }),
    ).toEqual({ mode: "shader", color: "#123456" });
  });

  it("round-trips a glsl config through localStorage", () => {
    const config = {
      mode: "glsl" as const,
      color: "#0a0a0a",
      shader: {
        presetId: "aurora",
        source:
          "precision highp float; void main(){ gl_FragColor = vec4(1.0); }",
        uniforms: { u_speed: 1, u_scale: 1, u_intensity: 1, u_seed: 0 },
      },
    };
    saveBackgroundConfig(config);
    expect(loadBackgroundConfig()).toEqual(config);
  });

  it("round-trips an image config through localStorage", () => {
    const config = {
      mode: "image" as const,
      color: "#0a0a0a",
      imageUrl: "data:image/png;base64,AAAA",
    };
    saveBackgroundConfig(config);
    expect(loadBackgroundConfig()).toEqual(config);
  });

  it("returns the default when nothing is stored", () => {
    expect(loadBackgroundConfig()).toEqual(DEFAULT);
  });

  it("returns the default when the stored value is corrupt", () => {
    localStorage.setItem("eliza:ui-background", "{not json");
    expect(loadBackgroundConfig()).toEqual(DEFAULT);
  });
});
