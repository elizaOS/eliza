// @vitest-environment jsdom
/**
 * applyThemeToDocument is Eliza's own theming path; it now reads the same
 * variables as themeCssVariables. These checks keep what it sets, the font
 * stylesheet link and the cleanup unchanged.
 */
import type { ThemeDefinition } from "@elizaos/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyThemeToDocument,
  ELIZA_DEFAULT_THEME,
  themeCssVariables,
} from "../theme";

const root = () => document.documentElement;
const fontLink = () =>
  document.head.querySelector<HTMLLinkElement>('link[rel="stylesheet"]');

afterEach(() => {
  root().removeAttribute("style");
  for (const link of document.head.querySelectorAll("link")) link.remove();
});

describe("applyThemeToDocument", () => {
  it("sets every theme variable on the root and removes exactly those on cleanup", () => {
    root().style.setProperty("--unrelated", "kept");
    const variables = themeCssVariables(ELIZA_DEFAULT_THEME, "dark");
    expect(variables["--bg"]).toBe(ELIZA_DEFAULT_THEME.dark.bg);
    expect(variables["--txt"]).toBe(ELIZA_DEFAULT_THEME.dark.text);
    const cleanup = applyThemeToDocument(ELIZA_DEFAULT_THEME, "dark");
    for (const [name, value] of Object.entries(variables))
      expect(root().style.getPropertyValue(name)).toBe(value);
    cleanup();
    for (const name of Object.keys(variables))
      expect(root().style.getPropertyValue(name)).toBe("");
    expect(root().style.getPropertyValue("--unrelated")).toBe("kept");
  });

  it("keeps --primary from the accent only when the theme sets no primary", () => {
    const theme: ThemeDefinition = {
      ...ELIZA_DEFAULT_THEME,
      light: { ...ELIZA_DEFAULT_THEME.light, accent: "#123456", primary: undefined },
    };
    expect(themeCssVariables(theme, "light")["--primary"]).toBe("#123456");
    const explicit: ThemeDefinition = {
      ...theme,
      light: { ...theme.light, primary: "#abcdef" },
    };
    expect(themeCssVariables(explicit, "light")["--primary"]).toBe("#abcdef");
  });

  it("injects the font stylesheet when named, drops it otherwise, and removes it on cleanup", () => {
    const withImport: ThemeDefinition = {
      ...ELIZA_DEFAULT_THEME,
      fonts: { body: "Inter, sans-serif", fontImportUrl: "https://fonts.googleapis.com/css2?family=Inter" },
    };
    const cleanup = applyThemeToDocument(withImport, "light");
    expect(root().style.getPropertyValue("--font-body")).toBe("Inter, sans-serif");
    expect(fontLink()?.href).toBe("https://fonts.googleapis.com/css2?family=Inter");
    applyThemeToDocument({ ...withImport, fonts: { body: "Inter, sans-serif" } }, "light");
    expect(fontLink()).toBeNull();
    applyThemeToDocument(withImport, "light");
    cleanup();
    expect(fontLink()).toBeNull();
    expect(root().style.getPropertyValue("--font-body")).toBe("");
  });
});
