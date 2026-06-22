// @vitest-environment jsdom
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
