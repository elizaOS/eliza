import { describe, expect, it } from "vitest";
import {
  extractBaseCommand,
  isForbiddenCommand,
  isSafeCommand,
  validatePath,
} from "../utils/pathUtils";

describe("Path Utilities", () => {
  describe("validatePath", () => {
    it("should allow paths within the allowed directory", () => {
      const result = validatePath("subfolder", "/home/user/allowed", "/home/user/allowed");
      expect(result).toBe("/home/user/allowed/subfolder");
    });

    it("should reject paths outside the allowed directory", () => {
      const result = validatePath("../../../etc", "/home/user/allowed", "/home/user/allowed");
      expect(result).toBeNull();
    });

    it("should handle absolute paths correctly", () => {
      const result = validatePath(
        "/home/user/allowed/sub",
        "/home/user/allowed",
        "/home/user/allowed"
      );
      expect(result).toBe("/home/user/allowed/sub");
    });
  });

  describe("isSafeCommand", () => {
    it("should allow safe commands", () => {
      expect(isSafeCommand("ls -la")).toBe(true);
      expect(isSafeCommand("echo hello")).toBe(true);
      expect(isSafeCommand("pwd")).toBe(true);
      // File operations should be allowed
      expect(isSafeCommand('echo "Hello World" > file.txt')).toBe(true);
      expect(isSafeCommand("cat < input.txt")).toBe(true);
      expect(isSafeCommand("touch newfile.txt")).toBe(true);
      expect(isSafeCommand("mkdir newdir")).toBe(true);
    });

    it("should reject commands with path traversal", () => {
      expect(isSafeCommand("cd ../..")).toBe(false);
      expect(isSafeCommand("ls ../../../etc")).toBe(false);
    });

    it("should reject commands with dangerous patterns", () => {
      expect(isSafeCommand("rm -rf / | sudo rm -rf /")).toBe(false);
      expect(isSafeCommand("echo $(malicious)")).toBe(false);
      expect(isSafeCommand("ls | grep test | wc -l")).toBe(false); // Multiple pipes
      expect(isSafeCommand("cmd1 && cmd2")).toBe(false);
      expect(isSafeCommand("cmd1 || cmd2")).toBe(false);
    });
  });

  describe("extractBaseCommand", () => {
    it("should extract the base command correctly", () => {
      expect(extractBaseCommand("ls -la")).toBe("ls");
      expect(extractBaseCommand("git status")).toBe("git");
      expect(extractBaseCommand("  npm   test  ")).toBe("npm");
    });

    it("should handle empty commands", () => {
      expect(extractBaseCommand("")).toBe("");
      expect(extractBaseCommand("   ")).toBe("");
    });
  });

  describe("isForbiddenCommand", () => {
    const forbidden = ["rm -rf /", "sudo rm -rf", "chmod 777", "shutdown"];

    it("should detect forbidden command patterns", () => {
      expect(isForbiddenCommand("rm -rf /", forbidden)).toBe(true);
      expect(isForbiddenCommand("sudo rm -rf /home", forbidden)).toBe(true);
      expect(isForbiddenCommand("chmod 777 /etc", forbidden)).toBe(true);
      expect(isForbiddenCommand("shutdown now", forbidden)).toBe(true);
    });

    it("should allow safe variations of commands", () => {
      expect(isForbiddenCommand("rm file.txt", forbidden)).toBe(false);
      expect(isForbiddenCommand("chmod 644 file", forbidden)).toBe(false);
      expect(isForbiddenCommand("sudo apt update", forbidden)).toBe(false);
    });

    it("should allow non-forbidden commands", () => {
      expect(isForbiddenCommand("ls -la", forbidden)).toBe(false);
      expect(isForbiddenCommand("echo hello", forbidden)).toBe(false);
      expect(isForbiddenCommand("brew install package", forbidden)).toBe(false);
    });

    it("should be case insensitive", () => {
      expect(isForbiddenCommand("RM -RF /", forbidden)).toBe(true);
      expect(isForbiddenCommand("SHUTDOWN", forbidden)).toBe(true);
    });
  });
});
