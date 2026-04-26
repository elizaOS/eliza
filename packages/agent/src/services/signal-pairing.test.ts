import { describe, expect, it, vi } from "vitest";
import {
  missingSignalCliMessage,
  resolveSignalCliExecutable,
  signalCliInstallInstructions,
} from "./signal-pairing";

describe("resolveSignalCliExecutable", () => {
  it("uses an existing signal-cli from PATH", async () => {
    const execFile = vi.fn(async (file: string, args?: readonly string[]) => {
      expect(file).toBe("/usr/bin/which");
      expect(args).toEqual(["signal-cli"]);
      return { stdout: "/opt/homebrew/bin/signal-cli\n", stderr: "" };
    });

    await expect(
      resolveSignalCliExecutable({
        env: {},
        execFile,
        existsSync: () => false,
        platform: "darwin",
      }),
    ).resolves.toBe("/opt/homebrew/bin/signal-cli");
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("auto-installs default signal-cli with Homebrew on macOS", async () => {
    const execFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("signal-cli missing"))
      .mockResolvedValueOnce({ stdout: "/opt/homebrew/bin/brew\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "/opt/homebrew/bin/signal-cli\n",
        stderr: "",
      });

    await expect(
      resolveSignalCliExecutable({
        env: {},
        execFile,
        existsSync: () => false,
        platform: "darwin",
      }),
    ).resolves.toBe("/opt/homebrew/bin/signal-cli");
    expect(execFile).toHaveBeenNthCalledWith(1, "/usr/bin/which", [
      "signal-cli",
    ]);
    expect(execFile).toHaveBeenNthCalledWith(2, "/usr/bin/which", ["brew"]);
    expect(execFile).toHaveBeenNthCalledWith(
      3,
      "/opt/homebrew/bin/brew",
      ["install", "signal-cli"],
      { env: {} },
    );
    expect(execFile).toHaveBeenNthCalledWith(4, "/usr/bin/which", [
      "signal-cli",
    ]);
  });

  it("auto-installs default signal-cli with Homebrew on Linux", async () => {
    const execFile = vi
      .fn()
      .mockRejectedValueOnce(new Error("signal-cli missing"))
      .mockResolvedValueOnce({
        stdout: "/home/linuxbrew/.linuxbrew/bin/brew\n",
        stderr: "",
      })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "/home/linuxbrew/.linuxbrew/bin/signal-cli\n",
        stderr: "",
      });

    await expect(
      resolveSignalCliExecutable({
        env: {},
        execFile,
        existsSync: () => false,
        platform: "linux",
      }),
    ).resolves.toBe("/home/linuxbrew/.linuxbrew/bin/signal-cli");
    expect(execFile).toHaveBeenNthCalledWith(1, "/usr/bin/which", [
      "signal-cli",
    ]);
    expect(execFile).toHaveBeenNthCalledWith(2, "/usr/bin/which", ["brew"]);
    expect(execFile).toHaveBeenNthCalledWith(
      3,
      "/home/linuxbrew/.linuxbrew/bin/brew",
      ["install", "signal-cli"],
      { env: {} },
    );
    expect(execFile).toHaveBeenNthCalledWith(4, "/usr/bin/which", [
      "signal-cli",
    ]);
  });

  it("returns null on Linux when Homebrew is unavailable", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("missing");
    });

    await expect(
      resolveSignalCliExecutable({
        env: {},
        execFile,
        existsSync: () => false,
        platform: "linux",
      }),
    ).resolves.toBeNull();
    expect(execFile).toHaveBeenNthCalledWith(1, "/usr/bin/which", [
      "signal-cli",
    ]);
    expect(execFile).toHaveBeenNthCalledWith(2, "/usr/bin/which", ["brew"]);
  });

  it("does not auto-install on Windows", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("missing");
    });

    await expect(
      resolveSignalCliExecutable({
        env: {},
        execFile,
        existsSync: () => false,
        platform: "win32",
      }),
    ).resolves.toBeNull();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("does not auto-install when a custom signal-cli path is configured", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("missing");
    });

    await expect(
      resolveSignalCliExecutable({
        cliPath: "/custom/bin/signal-cli",
        env: {},
        execFile,
        existsSync: () => false,
        platform: "darwin",
      }),
    ).resolves.toBeNull();
    expect(execFile).not.toHaveBeenCalledWith(
      expect.stringContaining("brew"),
      expect.anything(),
      expect.anything(),
    );
  });

  it("respects the auto-install opt-out", async () => {
    const execFile = vi.fn(async () => {
      throw new Error("missing");
    });

    await expect(
      resolveSignalCliExecutable({
        env: { MILADY_SIGNAL_CLI_AUTO_INSTALL: "0" },
        execFile,
        existsSync: () => false,
        platform: "darwin",
      }),
    ).resolves.toBeNull();
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("returns platform-specific fallback instructions", () => {
    expect(signalCliInstallInstructions("darwin")).toContain("macOS");
    expect(signalCliInstallInstructions("darwin")).toContain("Homebrew");
    expect(signalCliInstallInstructions("linux")).toContain("Linux");
    expect(signalCliInstallInstructions("linux")).toContain("Java Runtime 25+");
    expect(signalCliInstallInstructions("win32")).toContain("Windows");
    expect(signalCliInstallInstructions("win32")).toContain("signal-cli.bat");
    expect(missingSignalCliMessage(undefined, {}, "win32")).toContain(
      "SIGNAL_CLI_PATH",
    );
  });
});
