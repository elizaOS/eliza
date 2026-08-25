import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type HelperSpawn, runHelper } from "../src/helper";

function createFakeSpawn(options: {
  stdout?: string;
  stderr?: string;
  closeCode?: number;
  error?: Error;
}): { spawn: HelperSpawn; requests: string[] } {
  const requests: string[] = [];
  const spawn: HelperSpawn = vi.fn(() => {
    const proc = new EventEmitter() as ReturnType<HelperSpawn>;
    proc.stdout = new PassThrough() as never;
    proc.stderr = new PassThrough() as never;
    proc.stdin = new Writable({
      write(chunk, _encoding, callback) {
        requests.push(chunk.toString());
        callback();
      },
      final(callback) {
        queueMicrotask(() => {
          if (options.error) {
            proc.emit("error", options.error);
            return;
          }
          if (options.stdout) proc.stdout.end(options.stdout);
          else proc.stdout.end();
          if (options.stderr) proc.stderr.end(options.stderr);
          else proc.stderr.end();
          proc.emit("close", options.closeCode ?? 0);
        });
        callback();
      },
    }) as never;
    return proc;
  });

  return { spawn, requests };
}

describe("runHelper", () => {
  it("serializes the request and parses the last JSON stdout line", async () => {
    const { spawn, requests } = createFakeSpawn({
      stdout:
        'debug prelude\n{"success":true,"id":"alarm-1","fireAt":"2026-06-01T07:00:00Z"}\n',
      stderr: "diagnostic line",
    });

    await expect(
      runHelper(
        {
          action: "schedule",
          id: "alarm-1",
          timeIso: "2026-06-01T07:00:00Z",
          title: "Wake",
        },
        { spawnImpl: spawn, binPathOverride: "/tmp/helper" },
      ),
    ).resolves.toEqual({
      success: true,
      id: "alarm-1",
      fireAt: "2026-06-01T07:00:00Z",
    });

    expect(spawn).toHaveBeenCalledWith("/tmp/helper", []);
    expect(JSON.parse(requests.join("").trim())).toEqual({
      action: "schedule",
      id: "alarm-1",
      timeIso: "2026-06-01T07:00:00Z",
      title: "Wake",
    });
  });

  it.each([
    { stdout: "", message: "produced no stdout" },
    { stdout: "not json\n", message: /Unexpected token|JSON/ },
  ])("rejects malformed helper output %#", async ({ stdout, message }) => {
    const { spawn } = createFakeSpawn({ stdout });

    await expect(
      runHelper(
        { action: "permission" },
        { spawnImpl: spawn, binPathOverride: "/tmp/helper" },
      ),
    ).rejects.toThrow(message);
  });

  it("rejects spawn errors without hanging", async () => {
    const { spawn: fakeSpawn } = createFakeSpawn({
      error: new Error("spawn denied"),
    });

    await expect(
      runHelper(
        { action: "list" },
        { spawnImpl: fakeSpawn, binPathOverride: "/tmp/helper" },
      ),
    ).rejects.toThrow("spawn denied");
  });

  it("kills the spawned helper child when the timeout fires", async () => {
    // Regression for #22021: the timeout path used to reject without killing
    // the child, orphaning the real helper process and its stdio pipes. Use a
    // real long-lived child so the assertion observes actual process teardown
    // rather than a mock's bookkeeping.
    let child: ReturnType<typeof spawn> | undefined;
    const spawnImpl: HelperSpawn = () => {
      child = spawn("sleep", ["30"]);
      return child as never;
    };

    await expect(
      runHelper(
        { action: "list" },
        { spawnImpl, binPathOverride: "/tmp/helper", timeoutMs: 200 },
      ),
    ).rejects.toThrow(/timed out after 200ms/);

    // Let the SIGTERM be delivered and the process reaped.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(child).toBeDefined();
    expect(child?.killed).toBe(true);
    expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
  });

  describe("early-exiting helper does not escalate stdin EPIPE to a crash", () => {
    // Regression for #28419: runHelper wrote the request with `proc.stdin.end`
    // but attached no `error` listener to `proc.stdin`. When the real helper
    // exits before draining a large stdin, Node emits an EPIPE `error` on the
    // stdin stream; with no listener that becomes an uncaughtException and kills
    // the agent process. These cases use a REAL child process (no mocked SUT)
    // and a guard that fails if any EPIPE escapes to the process boundary.
    let escaped: unknown[];
    const onUncaught = (err: unknown) => escaped.push(err);

    beforeEach(() => {
      escaped = [];
      process.on("uncaughtException", onUncaught);
      process.on("unhandledRejection", onUncaught);
    });

    afterEach(async () => {
      // Let any late EPIPE from a still-draining pipe surface before asserting.
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUncaught);
      expect(escaped).toEqual([]);
    });

    // A ~2MB request that overruns the OS pipe buffer, guaranteeing the write is
    // still pending when the child that never reads stdin exits.
    const largeRequest = {
      action: "schedule" as const,
      id: "alarm-epipe",
      timeIso: "2026-06-01T07:00:00Z",
      title: "x".repeat(2_000_000),
    };

    it("resolves when the helper prints a valid response then exits without reading stdin", async () => {
      const spawnImpl: HelperSpawn = () =>
        spawn("sh", [
          "-c",
          'printf \'{"success":true,"alarms":[]}\\n\'; exit 0',
        ]) as never;

      await expect(
        runHelper(largeRequest, {
          spawnImpl,
          binPathOverride: "/tmp/helper",
        }),
      ).resolves.toEqual({ success: true, alarms: [] });
    });

    it("rejects with 'produced no stdout' when the helper exits early and prints nothing", async () => {
      const spawnImpl: HelperSpawn = () =>
        spawn("sh", ["-c", "exit 4"]) as never;

      await expect(
        runHelper(largeRequest, {
          spawnImpl,
          binPathOverride: "/tmp/helper",
        }),
      ).rejects.toThrow(/produced no stdout \(exit=4\)/);
    });
  });

  it("does not kill the child on the successful (non-timeout) path", async () => {
    // The fix must only tear down the child on timeout; a fast-closing helper
    // still resolves normally and is never signalled.
    const proc = new EventEmitter() as ReturnType<HelperSpawn>;
    const killed: string[] = [];
    proc.stdout = new PassThrough() as never;
    proc.stderr = new PassThrough() as never;
    proc.kill = ((signal?: NodeJS.Signals | number) => {
      killed.push(String(signal));
      return true;
    }) as never;
    proc.stdin = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        queueMicrotask(() => {
          proc.stdout.end('{"success":true}\n');
          proc.stderr.end();
          proc.emit("close", 0);
        });
        callback();
      },
    }) as never;

    await expect(
      runHelper(
        { action: "list" },
        {
          spawnImpl: () => proc,
          binPathOverride: "/tmp/helper",
          timeoutMs: 5_000,
        },
      ),
    ).resolves.toEqual({ success: true });

    expect(killed).toEqual([]);
  });
});
