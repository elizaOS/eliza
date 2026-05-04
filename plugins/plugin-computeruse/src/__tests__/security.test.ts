/**
 * Tests for platform/security.ts — path validation, command safety.
 */
import { describe, expect, it } from "vitest";
import {
  checkDangerousCommand,
  validateFilePath,
} from "../platform/security.js";

describe("validateFilePath", () => {
  it("allows normal file paths", () => {
    const result = validateFilePath("/tmp/test.txt", "read");
    expect(result.allowed).toBe(true);
  });

  it("blocks null bytes", () => {
    const result = validateFilePath("/tmp/test\0.txt", "write");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("null bytes");
  });

  it("blocks empty path", () => {
    const result = validateFilePath("", "read");
    expect(result.allowed).toBe(false);
  });

  it("blocks credential files for write", () => {
    const home = process.env.HOME ?? "/Users/test";
    const result = validateFilePath(`${home}/.ssh/id_rsa`, "write");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("SSH");
  });

  it("blocks credential files for delete", () => {
    const home = process.env.HOME ?? "/Users/test";
    const result = validateFilePath(`${home}/.aws/credentials`, "delete");
    expect(result.allowed).toBe(false);
  });

  it("blocks system directories for write", () => {
    if (process.platform === "darwin" || process.platform === "linux") {
      const result = validateFilePath("/boot/vmlinuz", "write");
      expect(result.allowed).toBe(false);
    }
  });

  it("blocks filesystem root for write", () => {
    const result = validateFilePath("/", "write");
    expect(result.allowed).toBe(false);
  });

  it("allows reading credential-adjacent files", () => {
    // Reading non-credential files in home should be fine
    const home = process.env.HOME ?? "/Users/test";
    const result = validateFilePath(`${home}/notes.txt`, "read");
    expect(result.allowed).toBe(true);
  });
});

describe("checkDangerousCommand", () => {
  it("blocks rm -rf /", () => {
    expect(checkDangerousCommand("rm -rf /").blocked).toBe(true);
    expect(checkDangerousCommand("rm -rf /*").blocked).toBe(true);
  });

  it("blocks rm -rf ~", () => {
    expect(checkDangerousCommand("rm -rf ~/").blocked).toBe(true);
  });

  it("blocks mkfs commands", () => {
    expect(checkDangerousCommand("mkfs.ext4 /dev/sda1").blocked).toBe(true);
  });

  it("blocks dd to raw disk", () => {
    expect(checkDangerousCommand("dd if=/dev/zero of=/dev/sda").blocked).toBe(
      true,
    );
  });

  it("blocks fork bombs", () => {
    expect(checkDangerousCommand(":(){ :|:& };:").blocked).toBe(true);
  });

  it("allows safe commands", () => {
    expect(checkDangerousCommand("ls -la").blocked).toBe(false);
    expect(checkDangerousCommand("echo hello").blocked).toBe(false);
    expect(checkDangerousCommand("git log --oneline").blocked).toBe(false);
    expect(checkDangerousCommand("npm install").blocked).toBe(false);
    expect(checkDangerousCommand("rm my-file.txt").blocked).toBe(false);
  });

  it("handles null/empty gracefully", () => {
    expect(checkDangerousCommand("").blocked).toBe(false);
    expect(checkDangerousCommand(null as unknown as string).blocked).toBe(
      false,
    );
  });
});
