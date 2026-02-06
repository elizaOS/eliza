import { describe, expect, it } from "vitest";
import {
  getPlatform,
  getServiceManager,
  isPlatformSupported,
} from "./index.js";

describe("getPlatform", () => {
  it("returns a string", () => {
    const platform = getPlatform();
    expect(typeof platform).toBe("string");
  });

  it("returns a known platform", () => {
    const platform = getPlatform();
    expect([
      "darwin",
      "linux",
      "win32",
      "freebsd",
      "openbsd",
      "sunos",
      "aix",
    ]).toContain(platform);
  });
});

describe("isPlatformSupported", () => {
  it("returns a boolean", () => {
    const supported = isPlatformSupported();
    expect(typeof supported).toBe("boolean");
  });
});

describe("getServiceManager", () => {
  it("returns a service manager on supported platforms", () => {
    if (!isPlatformSupported()) {
      expect(() => getServiceManager()).toThrow();
    } else {
      const manager = getServiceManager();
      expect(manager).toBeDefined();
      expect(manager.label).toBeDefined();
      expect(typeof manager.install).toBe("function");
      expect(typeof manager.uninstall).toBe("function");
      expect(typeof manager.start).toBe("function");
      expect(typeof manager.stop).toBe("function");
      expect(typeof manager.restart).toBe("function");
      expect(typeof manager.isInstalled).toBe("function");
      expect(typeof manager.isRunning).toBe("function");
    }
  });
});
