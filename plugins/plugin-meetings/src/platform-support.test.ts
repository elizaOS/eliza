import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import {
  chromiumExecutable,
  hasDisplay,
  resolveHeadlessMode,
  resolveMeetingRuntimeSupport,
} from "./platform-support.js";

vi.mock("node:fs", () => ({ existsSync: vi.fn(() => true) }));

const runtime = {} as IAgentRuntime;

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(existsSync).mockReturnValue(true);
});

describe("hasDisplay", () => {
  it("is always true on macOS and Windows regardless of DISPLAY", () => {
    expect(hasDisplay("darwin", {})).toBe(true);
    expect(hasDisplay("win32", {})).toBe(true);
  });

  it("on linux requires DISPLAY or WAYLAND_DISPLAY", () => {
    expect(hasDisplay("linux", {})).toBe(false);
    expect(hasDisplay("linux", { DISPLAY: ":99" })).toBe(true);
    expect(hasDisplay("linux", { WAYLAND_DISPLAY: "wayland-0" })).toBe(true);
    expect(hasDisplay("linux", { DISPLAY: "   " })).toBe(false);
  });
});

describe("resolveHeadlessMode", () => {
  it("honors an explicit truthy ELIZA_MEETINGS_HEADLESS", () => {
    for (const v of ["true", "1", "yes", "on", "TRUE"]) {
      expect(resolveHeadlessMode({ ELIZA_MEETINGS_HEADLESS: v }, "linux")).toBe(true);
    }
  });

  it("honors an explicit falsy ELIZA_MEETINGS_HEADLESS even with no display", () => {
    for (const v of ["false", "0", "no", "off"]) {
      expect(resolveHeadlessMode({ ELIZA_MEETINGS_HEADLESS: v }, "linux")).toBe(false);
    }
  });

  it("auto-detects: headed on macOS, headless on displayless linux", () => {
    expect(resolveHeadlessMode({}, "darwin")).toBe(false);
    expect(resolveHeadlessMode({}, "linux")).toBe(true);
    expect(resolveHeadlessMode({ DISPLAY: ":99" }, "linux")).toBe(false);
  });

  it("falls back to auto-detect on an unrecognized value", () => {
    expect(resolveHeadlessMode({ ELIZA_MEETINGS_HEADLESS: "maybe" }, "linux")).toBe(true);
    expect(resolveHeadlessMode({ ELIZA_MEETINGS_HEADLESS: "maybe", DISPLAY: ":0" }, "linux")).toBe(
      false,
    );
  });
});

describe("chromiumExecutable", () => {
  it("prefers ELIZA_MEETINGS_CHROMIUM_PATH override when it exists", () => {
    const r = chromiumExecutable("chrome", { ELIZA_MEETINGS_CHROMIUM_PATH: "/opt/chrome" });
    expect(r).toEqual({ source: "override", executablePath: "/opt/chrome" });
  });

  it("throws when the override path does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() => chromiumExecutable("chrome", { ELIZA_MEETINGS_CHROMIUM_PATH: "/nope" })).toThrow(
      /does not exist/,
    );
  });

  it("uses bundled Chromium when playwright has one installed", () => {
    vi.spyOn(chromium, "executablePath").mockReturnValue("/pw/chromium");
    const r = chromiumExecutable("chrome", {});
    expect(r).toEqual({ source: "bundled", executablePath: "/pw/chromium" });
  });

  it("falls back to the system channel when no bundled browser exists", () => {
    vi.spyOn(chromium, "executablePath").mockImplementation(() => {
      throw new Error("not installed");
    });
    expect(chromiumExecutable("msedge", {})).toEqual({ source: "channel", channel: "msedge" });
  });
});

describe("resolveMeetingRuntimeSupport", () => {
  it("is unsupported on a mobile platform even with an override set", () => {
    const r = resolveMeetingRuntimeSupport(
      runtime,
      { ELIZA_PLATFORM: "ios", ELIZA_MEETINGS_CHROMIUM_PATH: "/opt/chrome" },
      "linux",
    );
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/cannot run on a mobile/);
  });

  it("is supported on desktop with a bundled browser and reports the path", () => {
    vi.spyOn(chromium, "executablePath").mockReturnValue("/pw/chromium");
    const r = resolveMeetingRuntimeSupport(runtime, { DISPLAY: ":0" }, "linux");
    expect(r.supported).toBe(true);
    expect(r.chromiumPath).toBe("/pw/chromium");
    expect(r.headless).toBe(false);
  });

  it("is supported on desktop via the system channel fallback", () => {
    vi.spyOn(chromium, "executablePath").mockImplementation(() => {
      throw new Error("none");
    });
    const r = resolveMeetingRuntimeSupport(runtime, {}, "darwin");
    expect(r.supported).toBe(true);
    expect(r.chromiumPath).toBeUndefined();
  });

  it("surfaces a bad override path as an unsupported reason, not a crash", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    const r = resolveMeetingRuntimeSupport(
      runtime,
      { ELIZA_MEETINGS_CHROMIUM_PATH: "/nope" },
      "darwin",
    );
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/does not exist/);
  });

  it("reports the resolved headless mode alongside an unsupported verdict", () => {
    const r = resolveMeetingRuntimeSupport(runtime, { ELIZA_PLATFORM: "android" }, "linux");
    expect(r.supported).toBe(false);
    expect(r.headless).toBe(true);
  });
});
