/**
 * Exercises kill_app's production process boundary without terminating a real
 * process, including process-group, regex, wildcard, and path adversarial cases.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock, currentPlatformMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  currentPlatformMock: vi.fn<NodeJS.Platform>(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile: execFileMock,
}));

vi.mock("../platform/helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../platform/helpers.js")>()),
  currentPlatform: currentPlatformMock,
}));

import { killApp } from "../platform/launch.js";

describe("killApp invocation", () => {
  beforeEach(() => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null);
      return {};
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each(["0", "00", "000"])(
    "rejects process-group pid spelling %s",
    async (target) => {
      currentPlatformMock.mockReturnValue("linux");
      await expect(killApp(target)).rejects.toMatchObject({
        code: "COMPUTER_USE_KILL_INVALID_TARGET",
      });
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  it("normalizes a positive pid before invoking kill", async () => {
    currentPlatformMock.mockReturnValue("linux");
    await expect(killApp("004242")).resolves.toMatchObject({ pid: 4242 });
    expect(execFileMock).toHaveBeenCalledWith(
      "kill",
      ["-9", "4242"],
      { timeout: 10_000 },
      expect.any(Function),
    );
  });

  it.each(["2147483648", "999999999999999999999999999"])(
    "rejects an out-of-range Unix pid %s",
    async (target) => {
      currentPlatformMock.mockReturnValue("linux");
      await expect(killApp(target)).rejects.toMatchObject({
        code: "COMPUTER_USE_KILL_INVALID_TARGET",
      });
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );

  it("escapes a Unix process name before exact regex matching", async () => {
    currentPlatformMock.mockReturnValue("linux");
    await killApp("node.js");
    expect(execFileMock).toHaveBeenCalledWith(
      "pkill",
      ["-x", "node\\.js"],
      { timeout: 10_000 },
      expect.any(Function),
    );
  });

  it("passes a Windows image name with spaces as one argv", async () => {
    currentPlatformMock.mockReturnValue("win32");
    await killApp("My App");
    expect(execFileMock).toHaveBeenCalledWith(
      "taskkill",
      ["/F", "/IM", "My App.exe"],
      { timeout: 10_000 },
      expect.any(Function),
    );
  });

  it.each(["*.exe", "node?.exe", "../node", "dir\\node", "bad\nname"])(
    "rejects unsafe Windows image target %s",
    async (target) => {
      currentPlatformMock.mockReturnValue("win32");
      await expect(killApp(target)).rejects.toMatchObject({
        code: "COMPUTER_USE_KILL_INVALID_TARGET",
      });
      expect(execFileMock).not.toHaveBeenCalled();
    },
  );
});
