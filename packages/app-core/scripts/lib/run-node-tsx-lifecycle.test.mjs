/** Tests opt-in wrapper argument parsing, orphan detection, and tree signaling. */
import { describe, expect, it, vi } from "vitest";
import {
  parseRunNodeTsxArgs,
  signalChildProcessTree,
  startParentOrphanWatchdog,
} from "./run-node-tsx-lifecycle.mjs";

describe("run-node-tsx lifecycle", () => {
  it("parses the parent-lifetime flag only in wrapper position", () => {
    expect(
      parseRunNodeTsxArgs(["--exit-with-parent", "script.ts", "--flag"]),
    ).toEqual({
      childArgs: ["script.ts", "--flag"],
      exitWithParent: true,
    });
    expect(parseRunNodeTsxArgs(["script.ts", "--exit-with-parent"])).toEqual({
      childArgs: ["script.ts", "--exit-with-parent"],
      exitWithParent: false,
    });
  });

  it("signals a detached POSIX child group", () => {
    const killProcess = vi.fn();
    const child = {
      exitCode: null,
      signalCode: null,
      pid: 4242,
      kill: vi.fn(),
    };

    expect(
      signalChildProcessTree({
        child,
        killProcess,
        platform: "darwin",
        signal: "SIGTERM",
      }),
    ).toBe(true);
    expect(killProcess).toHaveBeenCalledExactlyOnceWith(-4242, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("fires once and clears the timer after reparenting to PID 1", () => {
    let parentPid = 100;
    let tick = () => {};
    const timer = { unref: vi.fn() };
    const clearIntervalFn = vi.fn();
    const onOrphan = vi.fn();
    const watchdog = startParentOrphanWatchdog({
      clearIntervalFn,
      onOrphan,
      readParentPid: () => parentPid,
      setIntervalFn: (callback) => {
        tick = callback;
        return timer;
      },
    });

    tick();
    expect(onOrphan).not.toHaveBeenCalled();
    parentPid = 1;
    expect(watchdog.check()).toBe(true);
    expect(onOrphan).toHaveBeenCalledOnce();
    expect(clearIntervalFn).toHaveBeenCalledExactlyOnceWith(timer);
    expect(watchdog.check()).toBe(false);
    expect(timer.unref).toHaveBeenCalledOnce();
  });
});
