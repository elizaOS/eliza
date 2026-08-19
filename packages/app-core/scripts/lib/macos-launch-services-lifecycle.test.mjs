/** Verifies exact instance ownership for the macOS LaunchServices dev fallback. */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildMacApplicationTerminationScript,
  claimMacApplicationAtPath,
  requestMacApplicationTermination,
  stopMacApplication,
} from "./macos-launch-services-lifecycle.mjs";

function successfulSpawn(commands, outputs = []) {
  return (_command, args) => {
    commands.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => {
      const output = outputs.shift();
      if (output !== undefined) child.stdout.emit("data", output);
      child.emit("exit", 0);
    });
    return child;
  };
}

const AUTHORITY = {
  canonicalAppPath: '/tmp/Exact "Dev".app',
  pid: 4312,
  launchTime: 1_786_000_000.25,
};

describe("macOS LaunchServices lifecycle", () => {
  it("binds termination to canonical path, PID, and launch identity", () => {
    const script = buildMacApplicationTerminationScript(AUTHORITY, false);
    expect(script).toContain('const targetPath = "/tmp/Exact \\"Dev\\".app"');
    expect(script).toContain("stringByResolvingSymlinksInPath");
    expect(script).toContain("candidate.pid !== 4312");
    expect(script).toContain("candidate.launchTime !== 1786000000.25");
    expect(script).toContain("app.terminate");
    expect(script).not.toContain("bundleIdentifier");
  });

  it("claims only one identity absent from the pre-open baseline", async () => {
    const result = await claimMacApplicationAtPath(
      "/tmp/Eliza Dev.app",
      [{ pid: 10, launchTime: 100 }],
      {
        spawnCommand: successfulSpawn(
          [],
          [
            JSON.stringify([
              { pid: 10, launchTime: 100 },
              { pid: 11, launchTime: 101 },
            ]),
          ],
        ),
        attempts: 1,
      },
    );
    expect(result).toEqual({
      ok: true,
      authority: {
        canonicalAppPath: "/tmp/Eliza Dev.app",
        pid: 11,
        launchTime: 101,
      },
      error: null,
    });
  });

  it("never adopts a pre-existing app at the same path", async () => {
    const result = await claimMacApplicationAtPath(
      "/tmp/Eliza Dev.app",
      [{ pid: 10, launchTime: 100 }],
      {
        spawnCommand: successfulSpawn(
          [],
          [JSON.stringify([{ pid: 10, launchTime: 100 }])],
        ),
        attempts: 1,
      },
    );
    expect(result).toMatchObject({ ok: false, authority: null });
  });

  it("requests graceful termination before an exact-instance forced fallback", async () => {
    const commands = [];
    const result = await stopMacApplication(AUTHORITY, {
      spawnCommand: successfulSpawn(commands),
      delay: (resolve) => resolve(),
    });
    expect(result).toEqual({
      graceful: { ok: true, error: null },
      forced: { ok: true, error: null },
    });
    expect(commands[0].at(-1)).toContain("app.terminate");
    expect(commands[1].at(-1)).toContain("app.forceTerminate");
  });

  it.skipIf(process.platform !== "darwin")(
    "executes an exact no-match authority without terminating another app",
    async () => {
      await expect(
        requestMacApplicationTermination(
          {
            canonicalAppPath:
              "/private/tmp/eliza-lifecycle-test-does-not-exist.app",
            pid: 2_147_483_647,
            launchTime: 0,
          },
          false,
        ),
      ).resolves.toEqual({ ok: true, error: null });
    },
  );
});
