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
    const { spawn } = createFakeSpawn({ error: new Error("spawn denied") });

    await expect(
      runHelper(
        { action: "list" },
        { spawnImpl: spawn, binPathOverride: "/tmp/helper" },
      ),
    ).rejects.toThrow("spawn denied");
  });
});
