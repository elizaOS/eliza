/** Bare Windows command names resolve through Path and PATHEXT before node-pty spawns them. */

import { describe, expect, it } from "vitest";
import type { PtyHandle } from "../services/pty-types";
import {
  resolveWindowsPtyCommand,
  withWindowsCommandLookup,
} from "../services/windows-pty-command";

const files = new Set([
  "C:\\Windows\\system32\\cmd.exe",
  "C:\\Users\\dev\\.bun\\bin\\bun.exe",
  "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
]);
const exists = (candidate: string) => files.has(candidate);
const env = {
  Path: "C:\\Windows\\system32;;relative\\bin;C:\\Users\\dev\\.bun\\bin;C:\\Users\\dev\\AppData\\Roaming\\npm",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
};

describe("resolveWindowsPtyCommand", () => {
  it("resolves bare names with the first matching Path entry and PATHEXT extension", () => {
    expect(resolveWindowsPtyCommand("cmd", env, exists)).toBe(
      "C:\\Windows\\system32\\cmd.exe",
    );
    expect(resolveWindowsPtyCommand("bun", env, exists)).toBe(
      "C:\\Users\\dev\\.bun\\bin\\bun.exe",
    );
    expect(resolveWindowsPtyCommand("claude", env, exists)).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\npm\\claude.cmd",
    );
  });

  it("reads Path and PATHEXT without regard to case", () => {
    expect(
      resolveWindowsPtyCommand(
        "cmd",
        { PATH: env.Path, pathext: ".EXE" },
        exists,
      ),
    ).toBe("C:\\Windows\\system32\\cmd.exe");
  });

  it("keeps names with an extension or a directory, and names that are not found", () => {
    for (const command of [
      "cmd.exe",
      "C:\\Windows\\system32\\cmd.exe",
      ".\\tool",
      "bin/tool",
      "missing",
      "",
    ]) {
      expect(resolveWindowsPtyCommand(command, env, exists)).toBe(command);
    }
  });

  it("never searches empty or relative Path entries", () => {
    const seen: string[] = [];
    resolveWindowsPtyCommand("missing", env, (candidate) => {
      seen.push(candidate);
      return false;
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((candidate) => /^[A-Z]:\\/.test(candidate))).toBe(true);
  });
});

describe("withWindowsCommandLookup", () => {
  it("passes the resolved file and leaves args and options unchanged", () => {
    const calls: Array<[string, string[], unknown]> = [];
    const spawn = withWindowsCommandLookup((file, args, options) => {
      calls.push([file, args, options]);
      return {} as PtyHandle;
    });
    const options = { cwd: "C:\\work", env: { Path: "C:\\none" } };
    spawn("C:\\Windows\\system32\\cmd.exe", ["/c", "echo hi"], options);
    expect(calls).toEqual([
      ["C:\\Windows\\system32\\cmd.exe", ["/c", "echo hi"], options],
    ]);
  });
});
