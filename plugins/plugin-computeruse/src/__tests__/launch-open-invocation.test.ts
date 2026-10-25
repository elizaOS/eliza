/**
 * Pins Windows COMPUTER_USE open to a constant ShellExecute script so neither
 * cmd nor PowerShell parses the target. Deterministic — no handler is spawned.
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

import { openTarget } from "../platform/launch.js";

describe("openTarget invocation", () => {
  const hostile = "https://example.com&calc.exe";

  beforeEach(() => {
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null);
      return {};
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the Windows target out of every command-line argument", async () => {
    currentPlatformMock.mockReturnValue("win32");

    await openTarget(hostile);

    expect(execFileMock).toHaveBeenCalledOnce();
    const [command, args, options] = execFileMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; timeout: number },
    ];
    expect(command).toBe("powershell.exe");
    expect(command).not.toBe("cmd");
    expect(args).not.toContain("/c");
    expect(args).not.toContain("start");
    expect(args.every((arg) => !arg.includes(hostile))).toBe(true);
    expect(args.at(-1)).toContain("UseShellExecute = $true");
    expect(args.at(-1)).toContain("SetEnvironmentVariable");
    expect(options.env.ELIZA_COMPUTERUSE_OPEN_TARGET).toBe(hostile);
  });

  it.each([
    ["darwin", "open"],
    ["linux", "xdg-open"],
  ] as const)("passes the target as one argv on %s", async (os, command) => {
    currentPlatformMock.mockReturnValue(os);

    await openTarget(hostile);

    expect(execFileMock).toHaveBeenCalledWith(
      command,
      [hostile],
      { timeout: 10_000 },
      expect.any(Function),
    );
  });

  it.each(["", "   "])("rejects an empty target", async (target) => {
    currentPlatformMock.mockReturnValue("win32");
    await expect(openTarget(target)).rejects.toMatchObject({
      code: "COMPUTER_USE_OPEN_INVALID_TARGET",
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("rejects null bytes before constructing a process environment", async () => {
    currentPlatformMock.mockReturnValue("win32");
    await expect(openTarget("safe\0unsafe")).rejects.toMatchObject({
      code: "COMPUTER_USE_OPEN_INVALID_TARGET",
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
