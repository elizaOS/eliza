/**
 * Exercises dev settings banner coloring with forced, disabled, empty, and multiline terminal output.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  colorizeDevSettingsBanner,
  colorizeDevSettingsStartupBanner,
} from "./dev-settings-banner-style.js";

describe("colorizeDevSettingsBanner", () => {
  it("returns input unchanged when NO_COLOR is set", () => {
    vi.stubEnv("NO_COLOR", "1");
    expect(colorizeDevSettingsBanner("╭─╮")).toBe("╭─╮");
  });

  it("returns empty and multiline input unchanged when color is disabled", () => {
    vi.stubEnv("NO_COLOR", "1");
    expect(colorizeDevSettingsBanner("")).toBe("");
    expect(colorizeDevSettingsBanner("a\nb")).toBe("a\nb");
  });

  it("colorizes box lines cyan when forced", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const out = colorizeDevSettingsBanner("╭────╮\n│ hi │");
    expect(out).toContain("\x1b[1;36m");
    expect(out).toContain("\x1b[0m");
  });

  it("skips color when FORCE_COLOR is zero", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "0");
    expect(colorizeDevSettingsBanner("╭─╮")).toBe("╭─╮");
  });
});

describe("colorizeDevSettingsStartupBanner", () => {
  it("returns input unchanged when NO_COLOR is set", () => {
    vi.stubEnv("NO_COLOR", "1");
    const text = "ORCHESTRATOR\n╭────╮";
    expect(colorizeDevSettingsStartupBanner(text)).toBe(text);
  });

  it("colorizes the figlet heading magenta and box cyan", () => {
    vi.stubEnv("NO_COLOR", undefined);
    vi.stubEnv("FORCE_COLOR", "1");
    const out = colorizeDevSettingsStartupBanner("ORCHESTRATOR\n╭────╮\n│ t │");
    expect(out).toContain("\x1b[1;35m");
    expect(out).toContain("\x1b[1;36m");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});
