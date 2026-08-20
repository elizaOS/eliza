/** Verifies background config persistence through the package's configured test harness. */
// @vitest-environment jsdom
/**
 * Background-config persistence (`persistence`): load/save round-trip and
 * `normalizeBackgroundConfig` clamping of malformed stored values. jsdom + real
 * `localStorage`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { getShaderPreset } from "../backgrounds/shader-presets";
import {
  loadBackgroundConfig,
  normalizeBackgroundConfig,
  saveBackgroundConfig,
} from "./persistence";
import {
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_BACKGROUND_CONFIG,
} from "./ui-preferences";

// The boot default is the Ember Night sunset wallpaper, returned for
// empty/absent/unusable-record input.
const DEFAULT = DEFAULT_BACKGROUND_CONFIG;
// A present-but-malformed config still collapses to the plain shader field (a
// bad shader / image-without-url can never wedge the background) — NOT the image
// boot default.
const SHADER_FALLBACK = {
  mode: "shader",
  color: DEFAULT_BACKGROUND_COLOR,
} as const;

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

  it("falls back to the boot default for unusable (absent) input", () => {
    // null / non-record → the boot default (curated image).
    expect(normalizeBackgroundConfig(null)).toEqual(DEFAULT);
    expect(normalizeBackgroundConfig("nope")).toEqual(DEFAULT);
  });

  it("collapses a malformed present config to the plain shader field", () => {
    // image mode with no usable url collapses to the shader (not the image
    // boot default) — a present-but-broken config can never wedge the bg.
    expect(normalizeBackgroundConfig({ mode: "image" })).toEqual(
      SHADER_FALLBACK,
    );
    // invalid color collapses to the default color
    expect(normalizeBackgroundConfig({ color: "red" })).toEqual(
      SHADER_FALLBACK,
    );
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

  it("restores a glsl preset from the compiled corpus and clamps its uniforms", () => {
    const preset = getShaderPreset("lava");
    expect(preset).toBeDefined();
    if (!preset) throw new Error("lava preset missing from test corpus");
    expect(
      normalizeBackgroundConfig({
        mode: "glsl",
        color: "#123456",
        shader: {
          presetId: "lava",
          source: "void main(){ for(;;){} gl_FragColor=vec4(1.0);}",
          uniforms: { u_speed: 999, u_scale: 2, u_intensity: 1, u_seed: 5 },
        },
      }),
    ).toEqual({
      mode: "glsl",
      color: "#123456",
      shader: {
        presetId: "lava",
        source: preset.source,
        // u_speed clamped from 999 → 3 (schema max); others kept.
        uniforms: { u_speed: 3, u_scale: 2, u_intensity: 1, u_seed: 5 },
      },
    });
  });

  it("collapses a glsl config without a known preset id to the color field", () => {
    // no shader payload
    expect(
      normalizeBackgroundConfig({ mode: "glsl", color: "#123456" }),
    ).toEqual({
      mode: "shader",
      color: "#123456",
    });
    // Arbitrary source never becomes a WebGL capability, even when plausible.
    expect(
      normalizeBackgroundConfig({
        mode: "glsl",
        color: "#123456",
        shader: {
          source: "void main(){ gl_FragColor=vec4(1.0);}",
        },
      }),
    ).toEqual({ mode: "shader", color: "#123456" });
    // Unknown preset ids also fail closed instead of trusting their source.
    expect(
      normalizeBackgroundConfig({
        mode: "glsl",
        color: "#123456",
        shader: {
          presetId: "not-a-preset",
          source: "void main(){ for(;;){} gl_FragColor=vec4(1.0);}",
        },
      }),
    ).toEqual({ mode: "shader", color: "#123456" });
  });

  it("round-trips a glsl config through localStorage", () => {
    const preset = getShaderPreset("aurora");
    expect(preset).toBeDefined();
    if (!preset) throw new Error("aurora preset missing from test corpus");
    const config = {
      mode: "glsl" as const,
      color: "#0a0a0a",
      shader: {
        presetId: "aurora",
        source: preset.source,
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

describe("boot-default migration (black shader → boot default, one-shot)", () => {
  it("rewrites a persisted old-default black shader to the boot default once", () => {
    // The previous boot default was eagerly persisted on first boot, so an
    // install that never chose a background stores exactly this shape.
    localStorage.setItem(
      "eliza:ui-background",
      JSON.stringify({ mode: "shader", color: DEFAULT_BACKGROUND_COLOR }),
    );
    expect(loadBackgroundConfig()).toEqual(DEFAULT);
    // The migration is one-shot: a deliberate return to the black shader
    // afterwards sticks on every future load.
    saveBackgroundConfig({ mode: "shader", color: DEFAULT_BACKGROUND_COLOR });
    expect(loadBackgroundConfig()).toEqual({
      mode: "shader",
      color: DEFAULT_BACKGROUND_COLOR,
    });
  });

  it("never touches an explicit non-default background", () => {
    localStorage.setItem(
      "eliza:ui-background",
      JSON.stringify({ mode: "shader", color: "#059669" }),
    );
    expect(loadBackgroundConfig()).toEqual({
      mode: "shader",
      color: "#059669",
    });
  });

  it("a fresh install is stamped migrated on first load (later black picks stick)", () => {
    expect(loadBackgroundConfig()).toEqual(DEFAULT);
    saveBackgroundConfig({ mode: "shader", color: DEFAULT_BACKGROUND_COLOR });
    expect(loadBackgroundConfig()).toEqual({
      mode: "shader",
      color: DEFAULT_BACKGROUND_COLOR,
    });
  });
});

describe("fresh-default flip to Ember Night preserves every stored preference", () => {
  // Per the #17143 review: a stored Canopy (or any wallpaper) record carries
  // no provenance distinguishing "old default" from "deliberate user pick",
  // so the default flip must NOT migrate stored values — fresh installs only.
  it("a fresh install (nothing stored) boots to the sunset default", () => {
    expect(loadBackgroundConfig()).toEqual({
      mode: "image",
      color: "#000000",
      imageUrl: "/bg-sunset.webp",
    });
  });

  it("a stored Canopy wallpaper is preserved verbatim across repeated loads", () => {
    const canopy = {
      mode: "image",
      color: "#000000",
      imageUrl: "/wallpapers/canopy.webp",
    } as const;
    localStorage.setItem("eliza:ui-background", JSON.stringify(canopy));
    // First load must not rewrite it…
    expect(loadBackgroundConfig()).toEqual(canopy);
    // …and neither may any subsequent ordinary load (no one-shot rewrite,
    // no deferred persistence of a different value underneath it).
    expect(loadBackgroundConfig()).toEqual(canopy);
    expect(
      JSON.parse(localStorage.getItem("eliza:ui-background") ?? "null"),
    ).toEqual(canopy);
  });

  it("a stored non-default wallpaper pick (Reef) is preserved untouched", () => {
    const reef = {
      mode: "image",
      color: "#000000",
      imageUrl: "/wallpapers/reef.webp",
    } as const;
    localStorage.setItem("eliza:ui-background", JSON.stringify(reef));
    expect(loadBackgroundConfig()).toEqual(reef);
  });

  it("a stored deliberate black shader (post-v2 stamp) is preserved", () => {
    // An install that already ran the v2 migration and then deliberately
    // picked black keeps black — the default flip adds no new migration.
    localStorage.setItem("eliza:ui-background-default-v2", "1");
    localStorage.setItem(
      "eliza:ui-background",
      JSON.stringify({ mode: "shader", color: DEFAULT_BACKGROUND_COLOR }),
    );
    expect(loadBackgroundConfig()).toEqual({
      mode: "shader",
      color: DEFAULT_BACKGROUND_COLOR,
    });
  });
});

describe("legacy wallpaper alias (bg-sunset.jpg → .webp)", () => {
  it("rewrites a persisted legacy jpg default to the webp that actually exists", () => {
    const config = normalizeBackgroundConfig({
      mode: "image",
      color: "#160d07",
      imageUrl: "/bg-sunset.jpg",
    });
    expect(config).toEqual({
      mode: "image",
      color: "#160d07",
      imageUrl: "/bg-sunset.webp",
    });
  });

  it("leaves non-legacy image urls untouched", () => {
    const config = normalizeBackgroundConfig({
      mode: "image",
      color: "#160d07",
      imageUrl: "/wallpapers/custom.webp",
    });
    expect(config).toEqual({
      mode: "image",
      color: "#160d07",
      imageUrl: "/wallpapers/custom.webp",
    });
  });
});
