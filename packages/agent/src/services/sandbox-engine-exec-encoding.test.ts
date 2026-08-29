/**
 * Boundary coverage for container exec stdio decoding. The sandbox exec path
 * accumulates the child's stdout/stderr across OS pipe chunks, so a multi-byte
 * code point that straddles a chunk boundary must survive: decoding each chunk
 * on its own substitutes U+FFFD on both sides of the split. Deterministic
 * harness — the real DockerEngine.execInContainer over real Readable streams,
 * with only `spawn` and host-executable resolution stubbed.
 */

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

vi.mock("@elizaos/shared/host-execution-env", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@elizaos/shared/host-execution-env")>();
  return { ...actual, resolveHostExecutable: () => "/usr/local/bin/docker" };
});

import { DockerEngine } from "./sandbox-engine.ts";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = { write: () => {}, end: () => {} };
  kill(): void {}
}

/** Let the stream deliver the chunk that was just written before the next one. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("container exec stdio decoding", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("preserves a code point split across two stdout chunks", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new DockerEngine().execInContainer({
      containerId: "sandbox-1",
      command: "cat notes.txt",
    });

    // "é" is 0xC3 0xA9; a 64KiB pipe read can end between the two bytes.
    child.stdout.write(Buffer.from([0xc3]));
    await flush();
    child.stdout.write(Buffer.from([0xa9]));
    await flush();
    child.stdout.end();
    child.emit("close", 0);

    const result = await pending;
    expect(result.stdout).toBe("é");
    expect(result.exitCode).toBe(0);
  });

  it("preserves a code point split across two stderr chunks", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new DockerEngine().execInContainer({
      containerId: "sandbox-1",
      command: "cat notes.txt",
    });

    // "世" is 0xE4 0xB8 0x96 — a three-byte point split after its first byte.
    child.stderr.write(Buffer.from([0xe4]));
    await flush();
    child.stderr.write(Buffer.from([0xb8, 0x96]));
    await flush();
    child.stderr.end();
    child.emit("close", 1);

    const result = await pending;
    expect(result.stderr).toBe("世");
  });

  it("still accumulates multi-chunk ASCII output in order", async () => {
    const child = new FakeChild();
    spawnMock.mockReturnValue(child);

    const pending = new DockerEngine().execInContainer({
      containerId: "sandbox-1",
      command: "echo hello",
    });

    child.stdout.write(Buffer.from("hel", "utf8"));
    await flush();
    child.stdout.write(Buffer.from("lo\n", "utf8"));
    await flush();
    child.stdout.end();
    child.emit("close", 0);

    const result = await pending;
    expect(result.stdout).toBe("hello\n");
  });
});
