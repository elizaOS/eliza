// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  applyUiTheme,
  getSystemTheme,
  loadUiThemeMode,
  normalizeUiTheme,
  normalizeUiThemeMode,
  resolveUiTheme,
} from "./persistence";

describe("fixed dark app appearance", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = "";
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("normalizes legacy, manual, and system choices to dark", () => {
    localStorage.setItem("eliza:ui-theme-mode", "light");

    expect(loadUiThemeMode()).toBe("dark");
    expect(normalizeUiThemeMode("light")).toBe("dark");
    expect(normalizeUiThemeMode("system")).toBe("dark");
    expect(normalizeUiTheme("light")).toBe("dark");
    expect(resolveUiTheme("system")).toBe("dark");
    expect(getSystemTheme()).toBe("dark");
  });

  it("applies dark document chrome even when a caller requests light", () => {
    applyUiTheme("light");

    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });
});
