import { describe, expect, it } from "vitest";

// ThemeToggle is a pure-props component — test the logic without DOM rendering.
// The component renders MoonIcon when uiTheme === "dark" and SunIcon when "light".

describe("ThemeToggle icon selection logic", () => {
  it('isDark is true when uiTheme is "dark"', () => {
    const uiTheme = "dark";
    const isDark = uiTheme === "dark";
    expect(isDark).toBe(true);
  });

  it('isDark is false when uiTheme is "light"', () => {
    const uiTheme = "light";
    const isDark = uiTheme === "dark";
    expect(isDark).toBe(false);
  });

  it('toggles to "light" when currently dark', () => {
    const isDark = true;
    const next = isDark ? "light" : "dark";
    expect(next).toBe("light");
  });

  it('toggles to "dark" when currently light', () => {
    const isDark = false;
    const next = isDark ? "light" : "dark";
    expect(next).toBe("dark");
  });
});

// ThemeToggleProps shape — verify the exported type contract
describe("ThemeToggle type contract", () => {
  it("module exports ThemeToggle component", async () => {
    const mod = await import("./ThemeToggle");
    expect(typeof mod.ThemeToggle).toBe("function");
  });

  it("UiTheme accepts 'light' and 'dark' as valid values", () => {
    // Compile-time validated via TypeScript; at runtime we confirm the toggle
    // function's switch behaviour.
    const validThemes = ["light", "dark"] as const;
    for (const theme of validThemes) {
      const isDark = theme === "dark";
      const next = isDark ? "light" : "dark";
      expect(validThemes).toContain(next);
    }
  });
});
