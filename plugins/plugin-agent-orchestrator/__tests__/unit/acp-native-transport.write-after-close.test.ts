/**
 * Regression: write-after-close on the agent stdin pipe must not crash the
 * host runtime.
 *
 * Live failure (sol-dev 2026-08-19, backend-hot.log line 600383): sub-agent
 * teardown called `closeSession` after the agent subprocess had already gone
 * away; the JSON-RPC write hit a broken pipe and the resulting EPIPE became an
 * uncaught exception that killed the entire eliza runtime ("Uncaught
 * exception: Error: write EPIPE ... acp-native-transport.ts:318 closeSession
 * <- acp-service.ts stopNativeClient"), 5 crashes in 24h, dropping a live
 * user turn mid-compose.
 *
 * The fix: all writes to the agent stdin go through a guard that checks
 * destroyed/ended state and swallows synchronous throws, plus a stdin 'error'
 * listener that absorbs the asynchronous EPIPE emission. These tests fail
 * against the unguarded transport (bare `proc.stdin.write`, no 'error'
 * listener) and pass with the guard.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeAcpClient } from "../../src/services/acp-native-transport.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

type MockProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: Writable;
  stdinWrites: string[];
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  pid?: number;
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
  p.killed = false;
  p.kill = vi.fn((signal?: NodeJS.Signals) => {
    p.killed = true;
    p.signalCode = signal ?? null;
    return true;
  });
  p.pid = Math.floor(Math.random() * 10_000) + 1_000;
  p.exitCode = null;
  p.signalCode = null;
  return p;
}

function queueProc(p = proc()): MockProc {
  spawnMock.mockImplementationOnce(() => p as never);
  return p;
}

async function waitForWrites(p: MockProc, count: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (p.stdinWrites.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`expected ${count} stdin writes, got ${p.stdinWrites.length}`);
}

function emitJson(p: MockProc, message: Record<string, unknown>): void {
  p.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
}

async function startClient(): Promise<{ client: NativeAcpClient; p: MockProc }> {
  const p = queueProc();
  const client = new NativeAcpClient({
    command: "agent-acp",
    cwd: "/tmp/native-acp",
    approvalPreset: "autonomous",
  });
  const started = client.start();
  await waitForWrites(p, 1);
  emitJson(p, { jsonrpc: "2.0", id: 1, result: {} });
  await started;
  return { client, p };
}

/** Replace the mock stdin with one whose write throws EPIPE synchronously. */
function breakStdinSync(p: MockProc): void {
  const err = Object.assign(new Error("write EPIPE"), {
    code: "EPIPE",
    errno: -32,
    syscall: "write",
  });
  p.stdin.write = (() => {
    throw err;
  }) as never;
}

describe("NativeAcpClient write-after-close (EPIPE crash regression)", () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("closeSession after the agent pipe breaks does not throw (teardown race)", async () => {
    const { client, p } = await startClient();
    breakStdinSync(p);
    // Before the guard: proc.stdin.write threw EPIPE synchronously out of
    // request(), escaping closeSession's .catch on the returned promise and
    // crashing the caller. Now it must resolve (best-effort teardown).
    await expect(client.closeSession("s-1")).resolves.toBeUndefined();
  });

  it("closeSession after stdin is destroyed does not throw and does not write", async () => {
    const { client, p } = await startClient();
    p.stdin.destroy();
    const writesBefore = p.stdinWrites.length;
    await expect(client.closeSession("s-1")).resolves.toBeUndefined();
    expect(p.stdinWrites.length).toBe(writesBefore);
  });

  it("an asynchronous stdin 'error' (EPIPE) is absorbed, not uncaught", async () => {
    const { p } = await startClient();
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    // Without a listener, EventEmitter turns 'error' into a throw — which is
    // exactly the uncaught exception that killed the runtime. The transport
    // must install a listener in start().
    expect(p.stdin.listenerCount("error")).toBeGreaterThan(0);
    expect(() => p.stdin.emit("error", err)).not.toThrow();
  });

  it("request over a broken pipe rejects with a transport-closed error instead of crashing", async () => {
    const { client, p } = await startClient();
    breakStdinSync(p);
    await expect(
      (
        client as unknown as {
          request(method: string, params: unknown): Promise<unknown>;
        }
      ).request("session/prompt", { sessionId: "s-1" }),
    ).rejects.toThrow(/transport closed/i);
  });

  it("notify over a destroyed pipe resolves silently (cancel during teardown)", async () => {
    const { client, p } = await startClient();
    p.stdin.destroy();
    await expect(client.cancel("s-1")).resolves.toBeUndefined();
  });

  it("normal request path is unchanged by the guard", async () => {
    const { client, p } = await startClient();
    const pending = (
      client as unknown as {
        request(method: string, params: unknown): Promise<unknown>;
      }
    ).request("session/new", { cwd: "/tmp" });
    await waitForWrites(p, 2);
    const written = JSON.parse(p.stdinWrites[1] ?? "{}") as {
      id: number;
      method: string;
    };
    expect(written.method).toBe("session/new");
    emitJson(p, { jsonrpc: "2.0", id: written.id, result: { sessionId: "s-9" } });
    await expect(pending).resolves.toEqual({ sessionId: "s-9" });
  });
});
