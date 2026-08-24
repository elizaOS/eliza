import { describe, expect, it } from "vitest";
import {
  getBrowserCaptureHooks,
  registerBrowserCaptureHooks,
} from "./browser-capture-hooks.ts";

describe("browser capture hooks registry", () => {
  it("returns null before any registration", () => {
    expect(getBrowserCaptureHooks()).toBeNull();
  });

  it("returns the registered hooks", () => {
    const hooks = {
      frameFile: "frame.png",
      startBrowserCapture: async () => {},
      stopBrowserCapture: async () => {},
    };
    registerBrowserCaptureHooks(hooks);
    expect(getBrowserCaptureHooks()).toBe(hooks);
  });

  it("overwrites on re-registration", () => {
    const first = {
      frameFile: "a.png",
      startBrowserCapture: async () => {},
      stopBrowserCapture: async () => {},
    };
    const second = {
      frameFile: "b.png",
      startBrowserCapture: async () => {},
      stopBrowserCapture: async () => {},
    };
    registerBrowserCaptureHooks(first);
    registerBrowserCaptureHooks(second);
    expect(getBrowserCaptureHooks()).toBe(second);
  });
});
