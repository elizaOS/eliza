import { describe, expect, it } from "vitest";
import { isSafeCommand } from "../utils/pathUtils";

/**
 * Tests for the shell command-injection guard (#8801 / #9943). isSafeCommand
 * gates what the shell plugin will run, so it is a security boundary — yet it
 * had no assertions. The dangerous-pattern set is pinned so a future edit that
 * weakens it fails loudly.
 */
describe("isSafeCommand", () => {
  it("allows ordinary commands (including a single pipe)", () => {
    for (const c of [
      "ls -la",
      "echo hello world",
      "git status",
      "cat file.txt | grep needle",
    ]) {
      expect(isSafeCommand(c)).toBe(true);
    }
  });

  it("rejects path traversal in any slash direction", () => {
    for (const c of ["cat ../../etc/passwd", "cd ..\\windows", "tail /.."]) {
      expect(isSafeCommand(c)).toBe(false);
    }
  });

  it("rejects command substitution and backticks", () => {
    expect(isSafeCommand("echo $(whoami)")).toBe(false);
    expect(isSafeCommand("echo `id`")).toBe(false);
  });

  it("rejects sudo chained after a pipe or semicolon", () => {
    expect(isSafeCommand("foo | sudo rm -rf /")).toBe(false);
    expect(isSafeCommand("x ; sudo y")).toBe(false);
  });

  it("rejects && and || chaining", () => {
    expect(isSafeCommand("a && b")).toBe(false);
    expect(isSafeCommand("a || b")).toBe(false);
  });

  it("rejects more than one pipe", () => {
    expect(isSafeCommand("a | b | c")).toBe(false);
    expect(isSafeCommand("a | b")).toBe(true);
  });
});
