import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  currentPlatform: vi.fn(() => "linux"),
  commandExists: vi.fn(() => false),
}));

vi.mock("node:child_process", () => ({
  default: { execSync: mocks.execSync },
  execSync: mocks.execSync,
}));
vi.mock("./helpers.js", () => ({
  currentPlatform: mocks.currentPlatform,
  commandExists: mocks.commandExists,
}));

import { logger } from "@elizaos/core";
import { extractA11yTree, isA11yAvailable } from "./a11y";

const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

afterEach(() => {
  warnSpy.mockClear();
  mocks.execSync.mockReset();
  mocks.currentPlatform.mockReset();
  mocks.commandExists.mockReset();
});

describe("isA11yAvailable", () => {
  it("is always available on macOS and Windows", () => {
    mocks.currentPlatform.mockReturnValue("darwin");
    expect(isA11yAvailable()).toBe(true);
    mocks.currentPlatform.mockReturnValue("win32");
    expect(isA11yAvailable()).toBe(true);
  });

  it("requires python3 or gdbus on Linux", () => {
    mocks.currentPlatform.mockReturnValue("linux");
    mocks.commandExists.mockReturnValue(false);
    expect(isA11yAvailable()).toBe(false);
    mocks.commandExists.mockImplementation((cmd: string) => cmd === "python3");
    expect(isA11yAvailable()).toBe(true);
    mocks.commandExists.mockImplementation((cmd: string) => cmd === "gdbus");
    expect(isA11yAvailable()).toBe(true);
  });

  it("is unavailable on unsupported platforms", () => {
    mocks.currentPlatform.mockReturnValue("freebsd");
    expect(isA11yAvailable()).toBe(false);
  });
});

describe("extractA11yTree", () => {
  it("returns null without invoking tooling on unsupported platforms", () => {
    mocks.currentPlatform.mockReturnValue("freebsd");
    expect(extractA11yTree()).toBeNull();
    expect(mocks.execSync).not.toHaveBeenCalled();
  });

  it("returns trimmed osascript output on macOS", () => {
    mocks.currentPlatform.mockReturnValue("darwin");
    mocks.execSync.mockReturnValue("  Application: Safari\nWindow: Main  ");
    expect(extractA11yTree()).toBe("Application: Safari\nWindow: Main");
  });

  it("returns null and warns when macOS extraction fails", () => {
    mocks.currentPlatform.mockReturnValue("darwin");
    mocks.execSync.mockImplementation(() => {
      throw new Error("osascript permission denied");
    });
    expect(extractA11yTree()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("macOS a11y extraction failed"),
    );
  });

  it("returns python3 output on Linux when python3 exists", () => {
    mocks.currentPlatform.mockReturnValue("linux");
    mocks.commandExists.mockImplementation((cmd: string) => cmd === "python3");
    mocks.execSync.mockReturnValue('{"role": "desktop"}');
    expect(extractA11yTree()).toBe('{"role": "desktop"}');
  });

  it("returns PowerShell output on Windows", () => {
    mocks.currentPlatform.mockReturnValue("win32");
    mocks.execSync.mockReturnValue("Button: OK\n");
    expect(extractA11yTree()).toBe("Button: OK");
  });

  it("warns and returns null when the Linux AT-SPI lane fails", () => {
    mocks.currentPlatform.mockReturnValue("linux");
    mocks.commandExists.mockReturnValue(true);
    mocks.execSync.mockImplementation(() => {
      throw new Error("AT-SPI unavailable");
    });
    expect(extractA11yTree()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Linux AT-SPI extraction failed"),
    );
  });

  it("never throws: unexpected lane errors degrade to null with a warning", () => {
    mocks.currentPlatform.mockReturnValue("linux");
    mocks.commandExists.mockImplementation(() => {
      throw new Error("unexpected lane failure");
    });
    expect(() => extractA11yTree()).not.toThrow();
    expect(extractA11yTree()).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[a11y] extractA11yTree failed"),
    );
  });
});
