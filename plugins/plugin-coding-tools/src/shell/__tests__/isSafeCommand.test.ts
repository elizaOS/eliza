/**
 * Shell command-injection guard tests for executable command strings.
 * They pin dangerous patterns that the shell plugin must reject before command execution reaches the service.
 */

import { describe, expect, it } from "vitest";
import { isSafeCommand } from "../utils/pathUtils";

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
    expect(isSafeCommand("echo 'literal `id` text'")).toBe(true);
  });

  it("rejects semicolon chaining that would run under shell -c", () => {
    expect(isSafeCommand("echo hi; touch /tmp/eliza-shell-semicolon")).toBe(
      false,
    );
    expect(isSafeCommand("echo hi ;id")).toBe(false);
    expect(isSafeCommand("x ; sudo y")).toBe(false);
  });

  it("rejects a line break used as a command separator", () => {
    expect(isSafeCommand("echo hi\nid")).toBe(false);
    expect(isSafeCommand("echo hi\r\nid")).toBe(false);
  });

  it("rejects other shell constructs that can launch or sequence commands", () => {
    expect(isSafeCommand("echo hi & touch /tmp/eliza-shell-background")).toBe(
      false,
    );
    expect(isSafeCommand("cat <(id)")).toBe(false);
    expect(isSafeCommand("(id)")).toBe(false);
    expect(isSafeCommand("echo hi > /tmp/eliza-shell-redirect")).toBe(false);
  });

  it("rejects a single pipe into a shell or interpreter", () => {
    expect(isSafeCommand("echo id | sh")).toBe(false);
    expect(isSafeCommand("echo id | bash")).toBe(false);
    expect(isSafeCommand("cat script.py | python3")).toBe(false);
    expect(isSafeCommand("echo id | /bin/sh")).toBe(false);
    expect(isSafeCommand("echo id | 'sh'")).toBe(false);
    expect(isSafeCommand("echo id | s\\h")).toBe(false);
    expect(isSafeCommand("echo id | env sh")).toBe(false);
    expect(isSafeCommand("echo id | xargs sh")).toBe(false);
    expect(isSafeCommand("cat file.txt | grep needle")).toBe(true);
  });

  it("allows control characters when they are quoted data", () => {
    expect(isSafeCommand("printf '%s' 'a;b & c'")).toBe(true);
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
