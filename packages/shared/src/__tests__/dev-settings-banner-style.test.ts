import { afterEach, describe, expect, it, vi } from "vitest";
import {
  colorizeDevSettingsBanner,
  colorizeDevSettingsStartupBanner,
} from "../dev-settings-banner-style.ts";

const KEYS = ["NO_COLOR", "FORCE_COLOR"] as const;

afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  vi.restoreAllMocks();
});

describe("colorizeDevSettingsBanner", () => {
  it("returns input unchanged when NO_COLOR is set", () => {
    process.env.NO_COLOR = "1";
    expect(colorizeDevSettingsBanner("╭─╮")).toBe("╭─╮");
  });

  it("colorizes box lines when forced", () => {
    process.env.FORCE_COLOR = "1";
    const out = colorizeDevSettingsBanner("╭────╮\n│ hi │");
    expect(out).toContain("\x1b[1;36m");
    expect(out).toContain("\x1b[0m");
  });

  it("skips when FORCE_COLOR is 0", () => {
    process.env.FORCE_COLOR = "0";
    expect(colorizeDevSettingsBanner("╭─╮")).toBe("╭─╮");
  });
});

describe("colorizeDevSettingsStartupBanner", () => {
  it("colorizes the figlet heading magenta and box cyan", () => {
    process.env.FORCE_COLOR = "1";
    const out = colorizeDevSettingsStartupBanner("ORCHESTRATOR\n╭────╮\n│ t │");
    expect(out).toContain("\x1b[1;35m"); // magenta heading
    expect(out).toContain("\x1b[1;36m"); // cyan box
  });

  it("returns input unchanged when color is disabled", () => {
    process.env.NO_COLOR = "1";
    const text = "ORCHESTRATOR\n╭────╮";
    expect(colorizeDevSettingsStartupBanner(text)).toBe(text);
  });
});
