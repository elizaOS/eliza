import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";

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
