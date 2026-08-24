/**
 * Unit coverage for terminal-capability detection: platform checks,
 * shell resolution, and missing-tool messaging for coding-tools. Deterministic
 * — manipulates env and mocks host executable resolution, no shell spawned.
 */
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  isAndroidRuntime,
  isAospTerminalRuntime,
  missingToolMessage,
  TERMINAL_TOOL_NAMES,
} from "./terminalCapabilities";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("isAndroidRuntime", () => {
  test("true for ELIZA_PLATFORM android case-insensitive and trimmed", () => {
    process.env.ELIZA_PLATFORM = "android";
    expect(isAndroidRuntime()).toBe(true);
    process.env.ELIZA_PLATFORM = "  ANDROID  ";
    expect(isAndroidRuntime()).toBe(true);
    process.env.ELIZA_PLATFORM = "Android";
    expect(isAndroidRuntime()).toBe(true);
  });

  test("true for ANDROID_ROOT or ANDROID_DATA", () => {
    delete process.env.ELIZA_PLATFORM;
    process.env.ANDROID_ROOT = "/system";
    expect(isAndroidRuntime()).toBe(true);
    delete process.env.ANDROID_ROOT;
    process.env.ANDROID_DATA = "/data";
    expect(isAndroidRuntime()).toBe(true);
  });

  test("false for other platforms and empty", () => {
    process.env.ELIZA_PLATFORM = "ios";
    delete process.env.ANDROID_ROOT;
    delete process.env.ANDROID_DATA;
    expect(isAndroidRuntime()).toBe(false);
    process.env.ELIZA_PLATFORM = "";
    expect(isAndroidRuntime()).toBe(false);
    delete process.env.ELIZA_PLATFORM;
    expect(isAndroidRuntime()).toBe(false);
  });
});

describe("isAospTerminalRuntime", () => {
  test("true only when android and ELIZA_AOSP_BUILD truthy", () => {
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_AOSP_BUILD = "1";
    expect(isAospTerminalRuntime()).toBe(true);
    process.env.ELIZA_AOSP_BUILD = "true";
    expect(isAospTerminalRuntime()).toBe(true);
    process.env.ELIZA_AOSP_BUILD = "yes";
    expect(isAospTerminalRuntime()).toBe(true);
  });

  test("false when not android or not truthy", () => {
    process.env.ELIZA_PLATFORM = "android";
    process.env.ELIZA_AOSP_BUILD = "0";
    expect(isAospTerminalRuntime()).toBe(false);
    process.env.ELIZA_AOSP_BUILD = "";
    expect(isAospTerminalRuntime()).toBe(false);
    process.env.ELIZA_PLATFORM = "ios";
    process.env.ELIZA_AOSP_BUILD = "1";
    expect(isAospTerminalRuntime()).toBe(false);
  });
});

describe("missingTerminalToolForCommand", () => {
  test("returns tool name when missing, undefined when present or sh", async () => {
    vi.doMock("@elizaos/shared/host-execution-env", async () => {
      const actual = await vi.importActual<
        typeof import("@elizaos/shared/host-execution-env")
      >("@elizaos/shared/host-execution-env");
      return {
        ...actual,
        resolveHostExecutable: (name: string) =>
          name === "git" ? "/usr/bin/git" : undefined,
      };
    });
    const { missingTerminalToolForCommand: mocked } = await import(
      "./terminalCapabilities"
    );
    expect(mocked("git status")).toBeUndefined();
    expect(mocked("rg --help")).toBe("rg");
    expect(mocked("acpx run")).toBe("acpx");
    expect(mocked("sh -c 'echo hi'")).toBeUndefined();
    expect(mocked("")).toBeUndefined();
    vi.doUnmock("@elizaos/shared/host-execution-env");
  });

  test("skips leading env assignments and quotes", async () => {
    vi.doMock("@elizaos/shared/host-execution-env", async () => {
      const actual = await vi.importActual<
        typeof import("@elizaos/shared/host-execution-env")
      >("@elizaos/shared/host-execution-env");
      return { ...actual, resolveHostExecutable: () => undefined };
    });
    const { missingTerminalToolForCommand: mocked } = await import(
      "./terminalCapabilities"
    );
    expect(mocked("FOO=bar BAZ=1 rg --help")).toBe("rg");
    expect(mocked('"rg" --help')).toBe("rg");
    expect(mocked("  ")).toBeUndefined();
    vi.doUnmock("@elizaos/shared/host-execution-env");
  });
});

describe("missingToolMessage", () => {
  test("mentions tool and android hint when android", () => {
    process.env.ELIZA_PLATFORM = "android";
    const msg = missingToolMessage("rg");
    expect(msg).toContain("rg");
    expect(msg).toContain("Android");
  });

  test("mentions PATH hint when not android", () => {
    delete process.env.ELIZA_PLATFORM;
    delete process.env.ANDROID_ROOT;
    const msg = missingToolMessage("rg");
    expect(msg).toContain("rg");
    expect(msg).toContain("PATH");
  });

  test("TERMINAL_TOOL_NAMES contains expected tools", () => {
    expect(TERMINAL_TOOL_NAMES).toContain("sh");
    expect(TERMINAL_TOOL_NAMES).toContain("git");
    expect(TERMINAL_TOOL_NAMES).toContain("bun");
  });
});
