/**
 * Coverage for dev settings banner style.
 */
import { describe, expect, it } from "vitest";

import {
  colorizeDevSettingsBanner,
  colorizeDevSettingsStartupBanner,
} from "./dev-settings-banner-style.js";

describe("colorizeDevSettingsBanner", () => {
  it("returns unchanged when NO_COLOR set", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      expect(colorizeDevSettingsBanner("hello")).toBe("hello");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it("returns unchanged for empty", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      expect(colorizeDevSettingsBanner("")).toBe("");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it("colorizes box lines when allowed", () => {
    const prevNoColor = process.env.NO_COLOR;
    const prevForce = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      const out = colorizeDevSettingsBanner("\u256Dhello");
      expect(out).toContain("\u256D");
    } finally {
      if (prevNoColor !== undefined) process.env.NO_COLOR = prevNoColor;
      else delete process.env.NO_COLOR;
      if (prevForce !== undefined) process.env.FORCE_COLOR = prevForce;
      else delete process.env.FORCE_COLOR;
      Object.defineProperty(process.stdout, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });

  it("handles multiline", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      expect(colorizeDevSettingsBanner("a\nb")).toBe("a\nb");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });
});

describe("colorizeDevSettingsStartupBanner", () => {
  it("returns unchanged when NO_COLOR", () => {
    const prev = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    try {
      expect(colorizeDevSettingsStartupBanner("hello")).toBe("hello");
    } finally {
      if (prev === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = prev;
    }
  });

  it("handles figlet heading", () => {
    const prevNoColor = process.env.NO_COLOR;
    const prevForce = process.env.FORCE_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = "1";
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      const out = colorizeDevSettingsStartupBanner("FIGLET\n\u256Dbox");
      expect(out).toContain("FIGLET");
      expect(out).toContain("\u256D");
    } finally {
      if (prevNoColor !== undefined) process.env.NO_COLOR = prevNoColor;
      else delete process.env.NO_COLOR;
      if (prevForce !== undefined) process.env.FORCE_COLOR = prevForce;
      else delete process.env.FORCE_COLOR;
      Object.defineProperty(process.stdout, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });
});
