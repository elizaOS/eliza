/**
 * Byte-boundary coverage for the native ACP transport's stdout reader. The
 * sub-agent's JSON-RPC lines arrive as OS pipe chunks, so a multi-byte code
 * point that straddles a chunk boundary must be reassembled before the line
 * is parsed — decoding each chunk on its own turns it into two U+FFFD that
 * then parse as real content. Deterministic harness: real NativeAcpClient,
 * spawn mocked to an EventEmitter-backed fake process.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeAcpClient } from "../../src/services/acp-native-transport.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

type MockProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: Writable;
  stdinWrites: string[];
  kill: ReturnType<typeof vi.fn>;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

const spawnMock = vi.mocked(spawn);

function proc(): MockProc {
  const p = new EventEmitter() as MockProc;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdinWrites = [];
  p.stdin = new Writable({
    write(chunk, _enc, cb) {
      p.stdinWrites.push(chunk.toString());
      cb();
    },
  });
  p.kill = vi.fn(() => true);
  p.pid = 4242;
  p.exitCode = null;
  p.signalCode = null;
  return p;
}

async function waitForWrites(p: MockProc, count: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (p.stdinWrites.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `expected ${count} stdin writes, got ${p.stdinWrites.length}`,
  );
}

async function startClient(onEvent: (message: unknown) => void) {
  const p = proc();
  spawnMock.mockImplementationOnce(() => p as never);
  const client = new NativeAcpClient({
    command: "agent-acp --flag",
    cwd: "/tmp/native-acp",
    approvalPreset: "autonomous",
    onEvent: onEvent as never,
  });
  const started = client.start();
  await waitForWrites(p, 1);
  p.stdout.emit("data", Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
  await started;
  return { client, p };
}

function splitAtByte(bytes: Buffer, marker: number): [Buffer, Buffer] {
  const at = bytes.indexOf(marker) + 1;
  return [bytes.subarray(0, at), bytes.subarray(at)];
}

describe("NativeAcpClient stdout decoding across chunk boundaries", () => {
  afterEach(() => {
    spawnMock.mockReset();
  });

  it("reassembles a two-byte code point split across two data events", async () => {
    const events: Array<{ method?: string; params?: { text?: string } }> = [];
    const { client, p } = await startClient((m) => events.push(m as never));

    const line = Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { text: "café" } })}\n`,
      "utf8",
    );
    // "é" is 0xC3 0xA9; a pipe read can end between them.
    const [head, tail] = splitAtByte(line, 0xc3);
    p.stdout.emit("data", head);
    p.stdout.emit("data", tail);
    await new Promise((resolve) => setImmediate(resolve));

    const update = events.find((e) => e.method === "session/update");
    expect(update?.params?.text).toBe("café");
    await client.stop?.().catch(() => {});
  });

  it("reassembles a three-byte code point split after its first byte", async () => {
    const events: Array<{ method?: string; params?: { text?: string } }> = [];
    const { client, p } = await startClient((m) => events.push(m as never));

    const line = Buffer.from(
      `${JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { text: "世界" } })}\n`,
      "utf8",
    );
    // "世" is 0xE4 0xB8 0x96.
    const [head, tail] = splitAtByte(line, 0xe4);
    p.stdout.emit("data", head);
    p.stdout.emit("data", tail);
    await new Promise((resolve) => setImmediate(resolve));

    const update = events.find((e) => e.method === "session/update");
    expect(update?.params?.text).toBe("世界");
    await client.stop?.().catch(() => {});
  });

  it("still frames whole-chunk ASCII lines exactly as before", async () => {
    const events: Array<{ method?: string; params?: { text?: string } }> = [];
    const { client, p } = await startClient((m) => events.push(m as never));

    p.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"session/update","params":{"text":"plain"}}\n',
      ),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(
      events.find((e) => e.method === "session/update")?.params?.text,
    ).toBe("plain");
    await client.stop?.().catch(() => {});
  });
});
