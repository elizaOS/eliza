import { describe, expect, it } from "vitest";
import {
  LsblkParseError,
  NoPrivilegeEscalatorError,
  UnmountFailedError,
  WriteIncompleteError,
} from "../errors";
import { findPrivilegeEscalator } from "../linux-backend";

describe("findPrivilegeEscalator", () => {
  const env = {} as NodeJS.ProcessEnv;

  it("prefers pkexec when present", async () => {
    const result = await findPrivilegeEscalator(env, {
      hasCommand: async (cmd) => cmd === "pkexec",
      sudoNonInteractiveOk: async () => false,
    });
    expect(result).toEqual({ command: "pkexec", argsPrefix: [] });
  });

  it("falls back to sudo -n when sudo creds are cached", async () => {
    const result = await findPrivilegeEscalator(env, {
      hasCommand: async (cmd) => cmd === "sudo",
      sudoNonInteractiveOk: async () => true,
    });
    expect(result).toEqual({ command: "sudo", argsPrefix: ["-n"] });
  });

  it("does not select interactive sudo unless MILADY_USB_ALLOW_SUDO=1", async () => {
    await expect(
      findPrivilegeEscalator(env, {
        hasCommand: async (cmd) => cmd === "sudo",
        sudoNonInteractiveOk: async () => false,
      }),
    ).rejects.toBeInstanceOf(NoPrivilegeEscalatorError);
  });

  it("uses interactive sudo when explicitly enabled", async () => {
    const result = await findPrivilegeEscalator(
      { MILADY_USB_ALLOW_SUDO: "1" } as NodeJS.ProcessEnv,
      {
        hasCommand: async (cmd) => cmd === "sudo",
        sudoNonInteractiveOk: async () => false,
      },
    );
    expect(result).toEqual({ command: "sudo", argsPrefix: [] });
  });

  it("falls back to kdesu", async () => {
    const result = await findPrivilegeEscalator(env, {
      hasCommand: async (cmd) => cmd === "kdesu",
      sudoNonInteractiveOk: async () => false,
    });
    expect(result.command).toBe("kdesu");
  });

  it("falls back to doas", async () => {
    const result = await findPrivilegeEscalator(env, {
      hasCommand: async (cmd) => cmd === "doas",
      sudoNonInteractiveOk: async () => false,
    });
    expect(result).toEqual({ command: "doas", argsPrefix: [] });
  });

  it("throws NoPrivilegeEscalatorError with install hints when nothing is available", async () => {
    try {
      await findPrivilegeEscalator(env, {
        hasCommand: async () => false,
        sudoNonInteractiveOk: async () => false,
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(NoPrivilegeEscalatorError);
      expect((err as Error).message).toMatch(/pkexec/);
      expect((err as Error).message).toMatch(/kdesu/);
      expect((err as Error).message).toMatch(/doas/);
    }
  });
});

describe("typed Linux errors", () => {
  it("UnmountFailedError carries device path + stderr", () => {
    const e = new UnmountFailedError("/dev/sdb1", "target is busy");
    expect(e.devicePath).toBe("/dev/sdb1");
    expect(e.stderr).toBe("target is busy");
    expect(e.message).toContain("/dev/sdb1");
    expect(e.message).toContain("busy");
  });

  it("WriteIncompleteError reports expected vs actual bytes", () => {
    const e = new WriteIncompleteError(1000, 500);
    expect(e.expectedBytes).toBe(1000);
    expect(e.actualBytes).toBe(500);
  });

  it("LsblkParseError truncates stdout snippet and preserves cause", () => {
    const cause = new SyntaxError("Unexpected token");
    const e = new LsblkParseError("garbage", cause);
    expect(e.stdoutSnippet).toBe("garbage");
    expect(e.cause).toBe(cause);
    expect(e.message).toContain("Unexpected token");
  });
});
