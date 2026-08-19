/**
 * Pins kill_app to exact pid/name argv. Origin used `pkill -f` (regex over
 * the full command line) and Windows `/IM` with unfiltered names. Deterministic.
 */

import { describe, expect, it } from "vitest";
import { resolveKillInvocation } from "../platform/launch.js";

describe("resolveKillInvocation", () => {
  it("kills a positive pid without a process-group signal", () => {
    expect(resolveKillInvocation("4242", "linux")).toEqual({
      command: "kill",
      args: ["-9", "4242"],
      isPid: true,
      value: "4242",
    });
    expect(resolveKillInvocation("4242", "win32")).toEqual({
      command: "taskkill",
      args: ["/F", "/PID", "4242"],
      isPid: true,
      value: "4242",
    });
  });

  it("refuses pid 0", () => {
    expect(() => resolveKillInvocation("0", "linux")).toThrow(/pid 0/i);
    expect(() => resolveKillInvocation("0", "win32")).toThrow(/pid 0/i);
  });

  it("uses exact-name pkill, not -f regex", () => {
    const unix = resolveKillInvocation("Safari", "darwin");
    expect(unix).toEqual({
      command: "pkill",
      args: ["-x", "Safari"],
      isPid: false,
      value: "Safari",
    });
    expect(unix.args).not.toContain("-f");
  });

  it("rejects regex and wildcard process names", () => {
    for (const name of [".", ".*", "*", "eliza|node", "foo bar", "../x"]) {
      expect(() => resolveKillInvocation(name, "linux")).toThrow(
        /exact executable name/,
      );
      expect(() => resolveKillInvocation(name, "win32")).toThrow(
        /exact executable name/,
      );
    }
  });

  it("Windows IM is a single .exe name with no wildcard", () => {
    expect(resolveKillInvocation("notepad", "win32")).toEqual({
      command: "taskkill",
      args: ["/F", "/IM", "notepad.exe"],
      isPid: false,
      value: "notepad",
    });
  });
});
