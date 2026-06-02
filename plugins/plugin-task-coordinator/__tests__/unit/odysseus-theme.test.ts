import { describe, expect, it } from "vitest";
import {
  buildThemeVars,
  DEFAULT_THEME,
  FONT_MAP,
  ODYSSEUS_THEMES,
  themeVars,
} from "../../src/odysseus/odysseus-theme";

const HEX = /^#[0-9a-f]{6}$/i;

describe("ODYSSEUS_THEMES", () => {
  it("carries odysseus's 16 built-in presets incl. the named ones", () => {
    const names = Object.keys(ODYSSEUS_THEMES);
    expect(names).toHaveLength(16);
    for (const n of ["dark", "light", "midnight", "cyberpunk", "gpt", "claude"]) {
      expect(names).toContain(n);
    }
    expect(DEFAULT_THEME).toBe("dark");
  });

  it("every preset is a valid 5-colour hex palette", () => {
    for (const palette of Object.values(ODYSSEUS_THEMES)) {
      for (const key of ["bg", "fg", "panel", "border", "red"] as const) {
        expect(palette[key]).toMatch(HEX);
      }
    }
  });
});

describe("buildThemeVars", () => {
  const dark = buildThemeVars(ODYSSEUS_THEMES.dark);

  it("passes the core palette through to odysseus-native vars", () => {
    expect(dark["--bg"]).toBe("#282c34");
    expect(dark["--fg"]).toBe("#9cdef2");
    expect(dark["--panel"]).toBe("#111111");
    expect(dark["--border"]).toBe("#355a66");
    expect(dark["--red"]).toBe("#e06c75");
  });

  it("remaps eliza semantic tokens onto the palette (so reused components inherit it)", () => {
    expect(dark["--card"]).toBe("#111111"); // panel
    expect(dark["--txt"]).toBe("#9cdef2"); // fg
    expect(dark["--text"]).toBe("#9cdef2");
    expect(dark["--accent"]).toBe("#e06c75"); // red
    expect(dark["--destructive"]).toBe("#e06c75");
    expect(dark["--ring"]).toBe("#e06c75");
  });

  it("derives valid hex syntax-highlight colours from the palette", () => {
    for (const k of [
      "--hl-bg",
      "--hl-keyword",
      "--hl-string",
      "--hl-comment",
      "--hl-function",
      "--hl-number",
      "--hl-builtin",
    ] as const) {
      expect(dark[k]).toMatch(HEX);
    }
  });

  it("picks --text-strong by background luminance (white on dark, black on light)", () => {
    expect(buildThemeVars(ODYSSEUS_THEMES.dark)["--text-strong"]).toBe("#ffffff");
    expect(buildThemeVars(ODYSSEUS_THEMES.paper)["--text-strong"]).toBe("#000000");
  });

  it("applies advanced overrides (gpt preset's bubble/input/send colours)", () => {
    const gpt = buildThemeVars(ODYSSEUS_THEMES.gpt);
    expect(gpt["--send-btn-bg"]).toBe("#949494");
    expect(gpt["--user-bubble-bg"]).toBe("#2f2f2f");
    expect(gpt["--input-bg"]).toBe("#2f2f2f");
  });

  it("leaves advanced bubble vars unset for plain presets", () => {
    expect(buildThemeVars(ODYSSEUS_THEMES.dark)["--send-btn-bg"]).toBeUndefined();
  });
});

describe("themeVars", () => {
  it("resolves a named preset to its built vars", () => {
    expect(themeVars("cyberpunk")["--bg"]).toBe(ODYSSEUS_THEMES.cyberpunk.bg);
  });

  it("falls back to the default theme for an unknown name", () => {
    expect(themeVars("does-not-exist")).toEqual(
      buildThemeVars(ODYSSEUS_THEMES[DEFAULT_THEME]),
    );
  });
});

describe("FONT_MAP", () => {
  it("maps odysseus's three font choices", () => {
    expect(Object.keys(FONT_MAP).sort()).toEqual(["mono", "sans", "serif"]);
    expect(FONT_MAP.mono).toContain("Fira Code");
  });
});
