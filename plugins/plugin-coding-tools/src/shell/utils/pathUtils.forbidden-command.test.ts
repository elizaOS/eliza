/**
 * Regression tests for isForbiddenCommand whitespace tokenization (issue
 * #29519). The blocklist gate must reject destructive commands the same way
 * the executor runs them: `bash -c` collapses inter-token whitespace and
 * runCommandSimple splits on /\s+/, so extra spaces, tabs, or newlines
 * between tokens must not let a canonical forbidden command slip past a
 * prefix comparison. Pure-function assertions on the real exported guard and
 * the shipped DEFAULT_FORBIDDEN_COMMANDS list.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_FORBIDDEN_COMMANDS } from "./config";
import { isForbiddenCommand } from "./pathUtils";

const forbidden = [...DEFAULT_FORBIDDEN_COMMANDS];

describe("isForbiddenCommand whitespace normalization", () => {
  it("blocks the canonical single-space forms", () => {
    for (const command of [
      "rm -rf /",
      "chmod 777",
      "kill -9",
      "sudo rm -rf",
      "dd if=/dev/zero",
    ]) {
      expect(isForbiddenCommand(command, forbidden)).toBe(true);
    }
  });

  it("blocks double-space, tab, and mixed-whitespace bypass variants", () => {
    const bypassVariants = [
      "rm  -rf  /",
      "rm\t-rf /",
      "rm \t -rf   /",
      "chmod  777",
      "chmod\t777 file",
      "kill  -9 1234",
      "kill\t-9\t1234",
      "sudo  rm  -rf",
      "sudo\trm -rf /",
      "dd  if=/dev/zero",
      "dd\tif=/dev/zero of=/dev/sda",
    ];
    for (const command of bypassVariants) {
      expect(
        isForbiddenCommand(command, forbidden),
        `expected blocked: ${JSON.stringify(command)}`,
      ).toBe(true);
    }
  });

  it("blocks leading whitespace and trailing-argument whitespace variants", () => {
    expect(isForbiddenCommand("  rm   -rf   /  ", forbidden)).toBe(true);
    expect(isForbiddenCommand("\trm -rf /home/user", forbidden)).toBe(true);
    expect(isForbiddenCommand("kill  -9   -1", forbidden)).toBe(true);
  });

  it("keeps blocking the destructive canonical prefix with an argument", () => {
    expect(isForbiddenCommand("rm -rf /home", forbidden)).toBe(true);
    expect(isForbiddenCommand("rm  -rf  /home", forbidden)).toBe(true);
  });

  it("still allows benign commands and non-matching prefixes", () => {
    for (const command of [
      "rm notes.txt",
      "rm -rf ~/x",
      "rm  -rf  ~/build",
      "ls -la",
      "chmod 644 file",
      "kill -TERM 100",
      "git status",
    ]) {
      expect(
        isForbiddenCommand(command, forbidden),
        `expected allowed: ${JSON.stringify(command)}`,
      ).toBe(false);
    }
  });

  it("matches single-word blocklist entries on the collapsed base command", () => {
    expect(isForbiddenCommand("reboot", forbidden)).toBe(true);
    expect(isForbiddenCommand("  reboot  now  ", forbidden)).toBe(true);
    expect(isForbiddenCommand("shutdown\t-h now", forbidden)).toBe(true);
  });

  it("ignores empty or whitespace-only blocklist entries", () => {
    expect(isForbiddenCommand("echo hi", ["", "   ", "\t"])).toBe(false);
  });
});
