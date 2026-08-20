/**
 * Real-path confinement for ShellService workdir and `cd`. Lexical
 * `path.resolve` plus `path.relative` treats a symlink inside the allowed
 * tree as contained; spawning with that cwd follows the link and runs
 * outside the sandbox. This harness is real filesystem, not mocked.
 */
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePath } from "./pathUtils.ts";

describe("validatePath — symlink workdir confinement", () => {
  const temps: string[] = [];
  afterEach(() => {
    for (const dir of temps.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const itSymlink = process.platform === "win32" ? it.skip : it;

  function sandbox(): { allowed: string; outside: string } {
    const root = mkdtempSync(path.join(tmpdir(), "eliza-shell-validate-"));
    temps.push(root);
    const allowed = path.join(root, "allowed");
    const outside = path.join(root, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    return { allowed, outside };
  }

  it("accepts a real descendant of the allowed directory", () => {
    const { allowed } = sandbox();
    const child = path.join(allowed, "sub");
    mkdirSync(child);
    expect(validatePath("sub", allowed, allowed)).toBe(realpathSync(child));
  });

  it("accepts a descendant whose name begins with two dots", () => {
    const { allowed } = sandbox();
    const child = path.join(allowed, "..safe");
    mkdirSync(child);
    expect(validatePath("..safe", allowed, allowed)).toBe(realpathSync(child));
  });

  it("rejects lexical .. escapes", () => {
    const { allowed } = sandbox();
    expect(validatePath("..", allowed, allowed)).toBeNull();
    expect(validatePath("../outside", allowed, allowed)).toBeNull();
  });

  itSymlink(
    "rejects a symlink whose realpath is outside the allowed tree",
    () => {
      const { allowed, outside } = sandbox();
      symlinkSync(outside, path.join(allowed, "escape"));
      expect(validatePath("escape", allowed, allowed)).toBeNull();
    },
  );

  itSymlink(
    "rejects a dangling outside symlink instead of treating it lexically",
    () => {
      const { allowed, outside } = sandbox();
      const absentOutsideTarget = path.join(outside, "not-created");
      symlinkSync(absentOutsideTarget, path.join(allowed, "escape"));

      expect(validatePath("escape/subdir", allowed, allowed)).toBeNull();
    },
  );

  itSymlink("accepts a symlink that stays inside the allowed tree", () => {
    const { allowed } = sandbox();
    const inner = path.join(allowed, "inner");
    mkdirSync(inner);
    symlinkSync(inner, path.join(allowed, "alias"));
    const validated = validatePath("alias", allowed, allowed);
    expect(validated).toBe(realpathSync(inner));
  });

  it("rejects missing paths and regular files because cwd must be a directory", () => {
    const { allowed } = sandbox();
    expect(validatePath("missing", allowed, allowed)).toBeNull();

    const file = path.join(allowed, "file.txt");
    closeSync(openSync(file, "w"));
    expect(validatePath("file.txt", allowed, allowed)).toBeNull();
  });
});
