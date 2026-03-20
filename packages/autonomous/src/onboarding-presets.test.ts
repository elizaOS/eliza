import { describe, expect, it } from "vitest";
import {
  CHARACTER_PRESET_META,
  STYLE_PRESETS,
  getPresetNameMap,
  getStylePresets,
} from "./onboarding-presets";

describe("getStylePresets", () => {
  it("returns the STYLE_PRESETS array", () => {
    expect(getStylePresets()).toBe(STYLE_PRESETS);
  });

  it("returns a non-empty array of presets with required fields", () => {
    const presets = getStylePresets();
    expect(presets.length).toBeGreaterThan(0);
    for (const preset of presets) {
      expect(preset).toHaveProperty("catchphrase");
      expect(preset).toHaveProperty("hint");
      expect(preset).toHaveProperty("bio");
      expect(preset).toHaveProperty("system");
    }
  });
});

describe("getPresetNameMap", () => {
  it("returns a name → catchphrase mapping", () => {
    const map = getPresetNameMap();
    expect(typeof map).toBe("object");
    for (const [name, catchphrase] of Object.entries(map)) {
      expect(typeof name).toBe("string");
      expect(typeof catchphrase).toBe("string");
      expect(name.length).toBeGreaterThan(0);
      expect(catchphrase.length).toBeGreaterThan(0);
    }
  });

  it("contains one entry per CHARACTER_PRESET_META value", () => {
    const map = getPresetNameMap();
    const metaValues = Object.values(CHARACTER_PRESET_META);
    expect(Object.keys(map).length).toBe(metaValues.length);
    for (const meta of metaValues) {
      expect(map[meta.name]).toBe(meta.catchphrase);
    }
  });

  it("maps are consistent with STYLE_PRESETS catchphrases", () => {
    const map = getPresetNameMap();
    const validCatchphrases = new Set(
      getStylePresets().map((p) => p.catchphrase),
    );
    for (const catchphrase of Object.values(map)) {
      expect(validCatchphrases.has(catchphrase)).toBe(true);
    }
  });
});
