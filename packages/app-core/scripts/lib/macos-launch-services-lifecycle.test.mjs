/** Verifies exact-path ownership for the macOS LaunchServices dev fallback. */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  buildMacApplicationTerminationScript,
  requestMacApplicationTermination,
  stopMacApplicationAtPath,
} from "./macos-launch-services-lifecycle.mjs";

function successfulSpawn(commands) {
  return (_command, args) => {
    commands.push(args);
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
}

describe("macOS LaunchServices lifecycle", () => {
  it("matches the canonical bundle path rather than a shared app name or id", () => {
    const script = buildMacApplicationTerminationScript(
      '/tmp/Exact "Dev".app',
      false,
    );
    expect(script).toContain('const target = "/tmp/Exact \\"Dev\\".app"');
    expect(script).toContain("$(bundlePath).stringByResolvingSymlinksInPath");
    expect(script).toContain("canonicalBundlePath === target");
    expect(script).toContain("app.terminate");
    expect(script).not.toContain("bundleIdentifier");
  });

  it("requests graceful termination before an exact-path forced fallback", async () => {
    const commands = [];
    const result = await stopMacApplicationAtPath("/tmp/Eliza Dev.app", {
      spawnCommand: successfulSpawn(commands),
      delay: (resolve) => resolve(),
    });

    expect(result).toEqual({
      graceful: { ok: true, error: null },
      forced: { ok: true, error: null },
    });
    expect(commands).toHaveLength(2);
    expect(commands[0].at(-1)).toContain("app.terminate");
    expect(commands[1].at(-1)).toContain("app.forceTerminate");
  });

  it.skipIf(process.platform !== "darwin")(
    "executes the generated JXA against a guaranteed no-match path",
    async () => {
      await expect(
        requestMacApplicationTermination(
          "/private/tmp/eliza-lifecycle-test-does-not-exist.app",
          false,
        ),
      ).resolves.toEqual({ ok: true, error: null });
    },
  );
});
