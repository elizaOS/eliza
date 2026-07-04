/**
 * Capability probe plus Chromium resolution — display detection, headless-mode
 * resolution, executable lookup, and overall meeting-runtime support.
 * Deterministic: node:fs and playwright are stubbed, no real browser.
 */

import { existsSync } from "node:fs";
import type { IAgentRuntime } from "@elizaos/core";
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      expect(resolveHeadlessMode({ ELIZA_MEETINGS_HEADLESS: v }, "linux")).toBe(
        true,
      );
    }
  });

  it("honors an explicit falsy ELIZA_MEETINGS_HEADLESS even with no display", () => {
    for (const v of ["false", "0", "no", "off"]) {
      expect(resolveHeadlessMode({ ELIZA_MEETINGS_HEADLESS: v }, "linux")).toBe(
        false,
      );
    }
  });

  it("auto-detects: headed on macOS, headless on displayless linux", () => {
    expect(resolveHeadlessMode({}, "darwin")).toBe(false);
    expect(resolveHeadlessMode({}, "linux")).toBe(true);
    expect(resolveHeadlessMode({ DISPLAY: ":99" }, "linux")).toBe(false);
  });

  it("falls back to auto-detect on an unrecognized value", () => {
    expect(
      resolveHeadlessMode({ ELIZA_MEETINGS_HEADLESS: "maybe" }, "linux"),
    ).toBe(true);
    expect(
      resolveHeadlessMode(
        { ELIZA_MEETINGS_HEADLESS: "maybe", DISPLAY: ":0" },
        "linux",
      ),
    ).toBe(false);
  });
});

describe("chromiumExecutable", () => {
  it("prefers ELIZA_MEETINGS_CHROMIUM_PATH override when it exists", () => {
    const r = chromiumExecutable(
      "chrome",
      { ELIZA_MEETINGS_CHROMIUM_PATH: "/opt/chrome" },
      "darwin",
    );
    expect(r).toEqual({ source: "override", executablePath: "/opt/chrome" });
  });

  it("throws when the override path does not exist", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(() =>
      chromiumExecutable(
        "chrome",
        { ELIZA_MEETINGS_CHROMIUM_PATH: "/nope" },
        "darwin",
      ),
    ).toThrow(/does not exist/);
  });

  it("prefers the system Chrome the user already has over a download", () => {
    // existsSync defaults to true → the first system path is 'installed'.
    const r = chromiumExecutable("chrome", {}, "darwin");
    expect(r).toEqual({
      source: "system",
      executablePath:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });
  });

  it("prefers system Edge first when the caller wants the Edge channel", () => {
    const r = chromiumExecutable("msedge", {}, "darwin");
    expect(r).toEqual({
      source: "system",
      executablePath:
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    });
  });

  it("uses bundled Chromium only when no system browser is installed", () => {
    vi.mocked(existsSync).mockImplementation(
      (p) => String(p) === "/pw/chromium",
    );
    vi.spyOn(chromium, "executablePath").mockReturnValue("/pw/chromium");
    const r = chromiumExecutable("chrome", {}, "linux");
    expect(r).toEqual({ source: "bundled", executablePath: "/pw/chromium" });
  });

  it("falls back to the system channel when nothing is resolvable", () => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.spyOn(chromium, "executablePath").mockImplementation(() => {
      throw new Error("not installed");
    });
    expect(chromiumExecutable("msedge", {}, "linux")).toEqual({
      source: "channel",
      channel: "msedge",
    });
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

  it("is supported on desktop via the user's system browser and reports its path", () => {
    const r = resolveMeetingRuntimeSupport(runtime, { DISPLAY: ":0" }, "linux");
    expect(r.supported).toBe(true);
    expect(r.chromiumPath).toBe("/usr/bin/google-chrome-stable");
    expect(r.headless).toBe(false);
  });

  it("is supported via a bundled browser when no system browser exists", () => {
    vi.mocked(existsSync).mockImplementation(
      (p) => String(p) === "/pw/chromium",
    );
    vi.spyOn(chromium, "executablePath").mockReturnValue("/pw/chromium");
    const r = resolveMeetingRuntimeSupport(runtime, { DISPLAY: ":0" }, "linux");
    expect(r.supported).toBe(true);
    expect(r.chromiumPath).toBe("/pw/chromium");
  });

  it("is supported on desktop via the system channel fallback", () => {
    vi.mocked(existsSync).mockReturnValue(false);
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
    const r = resolveMeetingRuntimeSupport(
      runtime,
      { ELIZA_PLATFORM: "android" },
      "linux",
    );
    expect(r.supported).toBe(false);
    expect(r.headless).toBe(true);
  });
});
