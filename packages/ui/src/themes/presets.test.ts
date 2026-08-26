// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { applyThemeToDocument, clearThemeOverrides } from "./apply-theme";
import { ELIZA_DEFAULT_THEME } from "./presets";

const getRootToken = (token: string): string =>
  document.documentElement.style.getPropertyValue(token);

const expectCanonicalSharedTokens = (): void => {
  expect(getRootToken("--accent")).toBe("#ff6a1f");
  expect(getRootToken("--accent-rgb")).toBe("255, 106, 31");
  expect(getRootToken("--accent-hover")).toBe("#ff7d3a");
  expect(getRootToken("--accent-muted")).toBe("#c94400");
  expect(getRootToken("--accent-foreground")).toBe("#000000");
  expect(getRootToken("--primary")).toBe("#ff6a1f");
  expect(getRootToken("--primary-foreground")).toBe("#000000");
  expect(getRootToken("--ring")).toBe("#ff6a1f");
  expect(getRootToken("--border-hover")).toBe("#ff6a1f");
  expect(getRootToken("--focus-ring")).toBe("none");
  expect(getRootToken("--duration-normal")).toBe("150ms");

  expect(getRootToken("--radius-sm")).toBe("8px");
  expect(getRootToken("--radius-md")).toBe("11px");
  expect(getRootToken("--radius-lg")).toBe("14px");
  expect(getRootToken("--radius-xl")).toBe("18px");
  expect(getRootToken("--radius-2xl")).toBe("22px");
  expect(getRootToken("--radius-3xl")).toBe("28px");
  expect(getRootToken("--radius")).toBe("11px");

  for (const token of [
    "--shadow-xs",
    "--shadow-sm",
    "--shadow-md",
    "--shadow-lg",
    "--shadow-xl",
    "--shadow-2xl",
    "--shadow-inset",
  ]) {
    expect(getRootToken(token)).toBe("none");
  }
};

afterEach(() => {
  clearThemeOverrides();
});

describe("ELIZA_DEFAULT_THEME", () => {
  it("installs the canonical light tokens at runtime", () => {
    applyThemeToDocument(ELIZA_DEFAULT_THEME, "light");

    expectCanonicalSharedTokens();
    expect(getRootToken("--bg")).toBe("#fdfaf7");
    expect(getRootToken("--bg-accent")).toBe("#f5f5f4");
    expect(getRootToken("--bg-elevated")).toBe("#ffffff");
    expect(getRootToken("--bg-hover")).toBe("#f0efed");
    expect(getRootToken("--bg-muted")).toBe("#e9e8e5");
    expect(getRootToken("--card")).toBe("#fdfaf7");
    expect(getRootToken("--surface")).toBe("#f5f5f4");
    expect(getRootToken("--input")).toBe("#fdfaf7");
    expect(getRootToken("--text")).toBe("#000000");
    expect(getRootToken("--focus")).toBe("rgba(255, 106, 31, 0.2)");
    expect(getRootToken("--ok")).toBe("#22c55e");
    expect(getRootToken("--destructive")).toBe("#ff6a1f");
    expect(getRootToken("--warn")).toBe("#ff6a1f");
    expect(getRootToken("--status-info")).toBe("rgba(0, 0, 0, 0.74)");
  });

  it("installs a true-black canvas and opaque neutral dark surfaces", () => {
    applyThemeToDocument(ELIZA_DEFAULT_THEME, "dark");

    expectCanonicalSharedTokens();
    expect(getRootToken("--bg")).toBe("#000000");
    expect(getRootToken("--bg-accent")).toBe("#121212");
    expect(getRootToken("--bg-muted")).toBe("#121212");
    expect(getRootToken("--card")).toBe("#121212");
    expect(getRootToken("--bg-elevated")).toBe("#1a1a1a");
    expect(getRootToken("--surface")).toBe("#1a1a1a");
    expect(getRootToken("--bg-hover")).toBe("#242424");
    expect(getRootToken("--input")).toBe("#242424");
    expect(getRootToken("--text")).toBe("#fdfaf7");
    expect(getRootToken("--focus")).toBe("rgba(255, 106, 31, 0.22)");
    expect(getRootToken("--ok")).toBe("#4ade80");
    expect(getRootToken("--destructive")).toBe("#ff6a1f");
    expect(getRootToken("--warn")).toBe("#ff6a1f");
    expect(getRootToken("--status-info")).toBe("rgba(255, 255, 255, 0.76)");
  });
});
