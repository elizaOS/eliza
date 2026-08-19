/** Exercises the bounded supervisor shutdown drain (elizaOS/eliza#16318). */
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isSpawnedProcessGroupAlive,
  signalSpawnedProcessGroup,
  signalSpawnedProcessTree,
} from "./kill-process-tree.mjs";
import {
  DEFAULT_SHUTDOWN_DRAIN_WINDOW_MS,
  drainSpawnedChildren,
  resolveShutdownDrainWindowMs,
  SHUTDOWN_DRAIN_WINDOW_ENV,
} from "./shutdown-drain.mjs";

const libDir = path.dirname(fileURLToPath(import.meta.url));

function makeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  return child;
}

function exitChild(child, code = 0) {
  child.exitCode = code;
  child.signalCode = code === null ? "SIGKILL" : null;
  child.emit("exit", code, child.signalCode);
}

describe("resolveShutdownDrainWindowMs", () => {
  it("defaults when the override is unset or empty", () => {
    expect(resolveShutdownDrainWindowMs({})).toBe(
      DEFAULT_SHUTDOWN_DRAIN_WINDOW_MS,
    );
    expect(
      resolveShutdownDrainWindowMs({ [SHUTDOWN_DRAIN_WINDOW_ENV]: "" }),
    ).toBe(DEFAULT_SHUTDOWN_DRAIN_WINDOW_MS);
  });

  it("honors a positive override, flooring fractions", () => {
    expect(
      resolveShutdownDrainWindowMs({ [SHUTDOWN_DRAIN_WINDOW_ENV]: "3000" }),
    ).toBe(3000);
    expect(
      resolveShutdownDrainWindowMs({ [SHUTDOWN_DRAIN_WINDOW_ENV]: "2500.9" }),
    ).toBe(2500);
  });

  it("degrades broken overrides to the default, never to zero", () => {
    for (const raw of [
      "nope",
      "-5",
      "0",
      "0.1",
      "0.999",
      "NaN",
      "Infinity",
      "2147483648",
      "1e20",
    ]) {
      expect(
        resolveShutdownDrainWindowMs({ [SHUTDOWN_DRAIN_WINDOW_ENV]: raw }),
      ).toBe(DEFAULT_SHUTDOWN_DRAIN_WINDOW_MS);
    }
  });

  it("accepts the timer-safe boundaries as-is", () => {
    // Guards the range staying inclusive: 1 is the smallest schedulable
    // window and 2147483647 the largest before Node's 32-bit overflow.
    expect(
      resolveShutdownDrainWindowMs({ [SHUTDOWN_DRAIN_WINDOW_ENV]: "1" }),
    ).toBe(1);
    expect(
      resolveShutdownDrainWindowMs({
        [SHUTDOWN_DRAIN_WINDOW_ENV]: "2147483647",
      }),
    ).toBe(2_147_483_647);
  });
});

describe("drainSpawnedChildren (deterministic)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("resolves immediately when no child is live, signaling nothing", async () => {
    const signalTree = vi.fn();
    const exited = makeChild();
    exited.exitCode = 0;
    const spawnFailed = makeChild();
    spawnFailed.pid = undefined;

    const result = await drainSpawnedChildren({
      children: [
        { name: "null", child: null },
        { name: "exited", child: exited },
        { name: "spawn-failed", child: spawnFailed },
      ],
      drainWindowMs: 5000,
      signalTree,
      log: () => {},
      warn: () => {},
    });

    expect(result).toEqual({ timedOut: false, killed: [] });
    expect(signalTree).not.toHaveBeenCalled();
  });

  it("SIGTERMs every live child up front and releases as soon as all exit", async () => {
    const signalTree = vi.fn();
    const a = makeChild();
    const b = makeChild();

    const drain = drainSpawnedChildren({
      children: [
        { name: "a", child: a },
        { name: "b", child: b },
      ],
      drainWindowMs: 5000,
      signalTree,
      log: () => {},
      warn: () => {},
    });

    expect(signalTree).toHaveBeenCalledWith(a, "SIGTERM");
    expect(signalTree).toHaveBeenCalledWith(b, "SIGTERM");

    exitChild(a);
    exitChild(b);
    // No timer advance: prompt exits must resolve the drain on their own.
    const result = await drain;
    expect(result).toEqual({ timedOut: false, killed: [] });
    expect(signalTree).not.toHaveBeenCalledWith(a, "SIGKILL");
    expect(signalTree).not.toHaveBeenCalledWith(b, "SIGKILL");
  });

  it("drains a target that remains alive after its launcher handle exited", async () => {
    const child = makeChild();
    child.exitCode = 0;
    let targetAlive = true;
    const signalTree = vi.fn(() => {
      targetAlive = false;
    });

    const drain = drainSpawnedChildren({
      children: [{ name: "detached-group", child }],
      drainWindowMs: 5_000,
      signalTree,
      isTargetAlive: () => targetAlive,
      log: () => {},
      warn: () => {},
    });

    expect(signalTree).toHaveBeenCalledWith(child, "SIGTERM");
    await vi.advanceTimersByTimeAsync(50);
    await expect(drain).resolves.toEqual({ timedOut: false, killed: [] });
  });

  it("escalates only stragglers when the window elapses, loudly", async () => {
    const signalTree = vi.fn();
    const warn = vi.fn();
    const prompt = makeChild();
    const straggler = makeChild();

    const drain = drainSpawnedChildren({
      children: [
        { name: "prompt", child: prompt },
        { name: "straggler", child: straggler },
      ],
      drainWindowMs: 5000,
      signalTree,
      log: () => {},
      warn,
    });

    exitChild(prompt);
    await vi.advanceTimersByTimeAsync(5000);

    expect(signalTree).toHaveBeenCalledWith(straggler, "SIGKILL");
    expect(signalTree).not.toHaveBeenCalledWith(prompt, "SIGKILL");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("straggler");
    expect(warn.mock.calls[0][0]).toContain("5000");

    // The kill lands within the grace: the drain still reports the timeout.
    exitChild(straggler, null);
    const result = await drain;
    expect(result).toEqual({ timedOut: true, killed: ["straggler"] });
  });

  it("gives up after the kill grace when even SIGKILL does not reap", async () => {
    const signalTree = vi.fn();
    const wedged = makeChild();

    const drain = drainSpawnedChildren({
      children: [{ name: "wedged", child: wedged }],
      drainWindowMs: 1000,
      killGraceMs: 500,
      signalTree,
      log: () => {},
      warn: () => {},
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(signalTree).toHaveBeenCalledWith(wedged, "SIGKILL");
    await vi.advanceTimersByTimeAsync(500);

    const result = await drain;
    expect(result).toEqual({ timedOut: true, killed: ["wedged"] });
  });
});

describe.skipIf(process.platform === "win32")(
  "drainSpawnedChildren (real processes)",
  () => {
    /**
     * Spawn a child that installs its SIGTERM disposition and then reports
     * readiness on stdout. Signaling before the handler is installed would
     * hit the default disposition and kill even the "stubborn" child.
     */
    async function spawnReadyScript(handlerSource) {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `${handlerSource}; process.stdout.write("ready"); setInterval(() => {}, 1000);`,
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      await once(child.stdout, "data");
      return child;
    }

    function isAlive(pid) {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    it("releases promptly when a real child honors SIGTERM", async () => {
      const child = await spawnReadyScript(
        'process.on("SIGTERM", () => process.exit(0))',
      );

      const startedAt = Date.now();
      const result = await drainSpawnedChildren({
        children: [{ name: "cooperative", child }],
        drainWindowMs: 8000,
        signalTree: signalSpawnedProcessTree,
        log: () => {},
        warn: () => {},
      });

      expect(result).toEqual({ timedOut: false, killed: [] });
      // Prompt exit must not burn the window; generous bound for slow CI.
      expect(Date.now() - startedAt).toBeLessThan(4000);
    }, 15_000);

    it("SIGKILLs a real child that ignores SIGTERM and reports it", async () => {
      const child = await spawnReadyScript('process.on("SIGTERM", () => {})');
      const warn = vi.fn();

      const result = await drainSpawnedChildren({
        children: [{ name: "stubborn", child }],
        drainWindowMs: 300,
        killGraceMs: 2000,
        signalTree: signalSpawnedProcessTree,
        log: () => {},
        warn,
      });

      expect(result.timedOut).toBe(true);
      expect(result.killed).toEqual(["stubborn"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(isAlive(child.pid)).toBe(false);
    }, 15_000);

    it("escalates a detached group when its launcher exits but a native descendant ignores SIGTERM", async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          `const { spawn } = require("node:child_process");
           const app = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] });
           process.on("SIGTERM", () => process.exit(0));
           app.stdout.once("data", () => process.stdout.write(String(app.pid)));
           setInterval(() => {}, 1000);`,
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const [chunk] = await once(child.stdout, "data");
      const descendantPid = Number.parseInt(String(chunk), 10);
      expect(descendantPid).toBeGreaterThan(0);

      const warn = vi.fn();
      const result = await drainSpawnedChildren({
        children: [{ name: "electrobun", child }],
        drainWindowMs: 300,
        killGraceMs: 2_000,
        signalTree: signalSpawnedProcessGroup,
        isTargetAlive: isSpawnedProcessGroupAlive,
        log: () => {},
        warn,
      });

      expect(result).toEqual({ timedOut: true, killed: ["electrobun"] });
      expect(warn).toHaveBeenCalledOnce();
      expect(isAlive(descendantPid)).toBe(false);
    }, 15_000);
  },
);

describe("dev-ui supervisor wiring", () => {
  const devUiSource = readFileSync(
    path.join(libDir, "..", "dev-ui.mjs"),
    "utf8",
  );

  it("routes cleanup through the bounded drain", () => {
    expect(devUiSource).toContain("void drainSpawnedChildren({");
    expect(devUiSource).toContain("drainWindowMs: SHUTDOWN_DRAIN_WINDOW_MS,");
    expect(devUiSource).toContain("signalTree: signalSpawnedProcessTree,");
  });

  it("no longer SIGKILLs children on a fixed fuse", () => {
    expect(devUiSource).not.toContain('terminateChild(viteProcess, "SIGKILL")');
    expect(devUiSource).not.toContain("}, 1500).unref();");
    expect(devUiSource).not.toContain("}, 1800).unref();");
  });

  it("keeps the second-signal force exit", () => {
    expect(devUiSource).toContain('console.log("\\n[eliza] Force exit.");');
    expect(devUiSource).toContain(
      "process.exit(exitCode === 0 ? 1 : exitCode);",
    );
  });
});

describe("dev-platform supervisor wiring", () => {
  const devPlatformSource = readFileSync(
    path.join(libDir, "..", "dev-platform.mjs"),
    "utf8",
  );

  it("routes shutdownDesktopDev through the bounded drain", () => {
    expect(devPlatformSource).toContain("drainSpawnedChildren({");
    expect(devPlatformSource).toContain(
      "drainWindowMs: SHUTDOWN_DRAIN_WINDOW_MS,",
    );
    expect(devPlatformSource).toContain(
      "signalTree: signalSpawnedProcessGroup,",
    );
    expect(devPlatformSource).toContain(
      "isTargetAlive: isSpawnedProcessGroupAlive,",
    );
  });

  it("owns the exact LaunchServices fallback through shutdown", () => {
    expect(devPlatformSource).toContain('["-W", launchServicesAppPath]');
    expect(devPlatformSource).toContain(
      "stopMacApplicationAtPath(launchServicesAppPath)",
    );
    expect(devPlatformSource).not.toContain("opener.unref()");
  });

  it("no longer SIGKILLs surviving children on a fixed fuse", () => {
    expect(devPlatformSource).not.toContain("}, 1500).unref();");
  });

  it("names tracked children for loud escalation logs", () => {
    // pushChild is generic (called with "vite" and "electrobun"): the stored
    // name must be the caller's argument, never a hard-coded literal, or a
    // Vite straggler is misreported as Electrobun (#18708 review, @w1kke).
    expect(devPlatformSource).toContain("childNames.set(child, name);");
    expect(devPlatformSource).not.toContain(
      'childNames.set(child, "electrobun");',
    );
    expect(devPlatformSource).toContain('childNames.set(child, "api");');
  });
});
