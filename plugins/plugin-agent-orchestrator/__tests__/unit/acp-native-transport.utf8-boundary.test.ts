/**
 * UTF-8 and EOF framing contract of NativeAcpClient's stdout reader. Pipe
 * reads can end inside a multi-byte code point or inside a JSON-RPC frame: the
 * real client must reassemble split code points, dispatch newline-terminated
 * frames whole, and fail with a typed error when EOF leaves incomplete bytes
 * or an unterminated frame.
 *
 * The first suite substitutes spawn with an emitter-backed process so byte
 * boundaries are placed deterministically. The second runs a real Node
 * subprocess over OS pipes and confirms that the parent actually received
 * chunks starting mid code point. Every client is torn down through close(),
 * whose failures fail the test.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NativeAcpClient } from "../../src/services/acp-native-transport.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  // Real spawn unless a test queues an emitter-backed process.
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const spawnMock = vi.mocked(spawn);

// Two-, three- and four-byte code points.
const TEXT = "café 世界 🌿";
const SESSION_ID = "utf8-session";

const update = {
  jsonrpc: "2.0",
  method: "session/update",
  params: {
    sessionId: SESSION_ID,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: TEXT },
    },
  },
};

function frame(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

type EmitterProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: Writable;
  stdinWrites: string[];
  killed: boolean;
  kill: (signal?: NodeJS.Signals) => boolean;
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
};

function emitterProc(): EmitterProc {
  const p = new EventEmitter() as EmitterProc;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdinWrites = [];
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    if (p.exitCode !== null || p.signalCode !== null) return;
    p.exitCode = code;
    p.signalCode = signal;
    queueMicrotask(() => p.emit("close", code, signal));
  };
  // Like an ACP agent, the process exits when its stdin reaches EOF.
  p.stdin = new Writable({
    write(chunk, _encoding, callback) {
      p.stdinWrites.push(chunk.toString());
      callback();
    },
    final(callback) {
      exit(0, null);
      callback();
    },
  });
  p.killed = false;
  p.kill = (signal: NodeJS.Signals = "SIGTERM") => {
    p.killed = true;
    exit(null, signal);
    return true;
  };
  p.pid = 4242;
  p.exitCode = null;
  p.signalCode = null;
  return p;
}

async function waitFor(check: () => boolean, what: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 2_000) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function requestId(p: EmitterProc, method: string): number {
  for (const write of p.stdinWrites) {
    const message = JSON.parse(write) as { id?: number; method?: string };
    if (message.method === method && typeof message.id === "number") {
      return message.id;
    }
  }
  throw new Error(`no ${method} request was written`);
}

function recordTexts(): {
  texts: string[];
  onEvent: (message: unknown) => void;
} {
  const texts: string[] = [];
  return {
    texts,
    onEvent(message) {
      const text = (
        message as { params?: { update?: { content?: { text?: unknown } } } }
      ).params?.update?.content?.text;
      if (typeof text === "string") texts.push(text);
    },
  };
}

async function closeAndConfirmExit(
  client: NativeAcpClient,
  child: Pick<ChildProcess, "exitCode" | "signalCode">,
): Promise<void> {
  await client.close();
  expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
}

describe("NativeAcpClient stdout over an emitter-backed process", () => {
  async function startWithSessionRequest() {
    const p = emitterProc();
    spawnMock.mockImplementationOnce(() => p as never);
    const recorder = recordTexts();
    const client = new NativeAcpClient({
      command: "agent-acp",
      cwd: "/tmp/native-acp",
      approvalPreset: "autonomous",
      onEvent: recorder.onEvent as never,
    });
    const started = client.start();
    await waitFor(() => p.stdinWrites.length >= 1, "initialize");
    p.stdout.emit(
      "data",
      frame({
        jsonrpc: "2.0",
        id: requestId(p, "initialize"),
        result: { protocolVersion: 1, agentCapabilities: {} },
      }),
    );
    await started;
    const session = client.createSession();
    await waitFor(() => p.stdinWrites.length >= 2, "session/new");
    const result = frame({
      jsonrpc: "2.0",
      id: requestId(p, "session/new"),
      result: { sessionId: SESSION_ID },
    });
    return { p, client, session, result, texts: recorder.texts };
  }

  it("reassembles 2-, 3- and 4-byte code points split at every byte and keeps a final complete frame", async () => {
    const { p, client, session, result, texts } =
      await startWithSessionRequest();
    try {
      for (const byte of Buffer.concat([frame(update), result])) {
        p.stdout.emit("data", Buffer.of(byte));
      }
      // EOF directly after a newline-terminated frame is a clean end.
      p.stdout.emit("end");
      await expect(session).resolves.toMatchObject({ sessionId: SESSION_ID });
      expect(texts).toEqual([TEXT]);
    } finally {
      await closeAndConfirmExit(client, p);
    }
  });

  it("dispatches the complete frame, then rejects incomplete UTF-8 bytes at EOF", async () => {
    const { p, client, session, texts } = await startWithSessionRequest();
    try {
      const partialCodePoint = Buffer.from("🌿", "utf8").subarray(0, 3);
      p.stdout.emit("data", Buffer.concat([frame(update), partialCodePoint]));
      p.stdout.emit("end");
      await expect(session).rejects.toMatchObject({
        code: "ACP_INVALID_UTF8",
      });
      expect(texts).toEqual([TEXT]);
      expect(p.killed).toBe(true);
    } finally {
      await closeAndConfirmExit(client, p);
    }
  });

  it("dispatches the complete frame, then rejects an unterminated frame at EOF", async () => {
    const { p, client, session, result, texts } =
      await startWithSessionRequest();
    try {
      // The session/new result cut off before its closing braces and newline.
      const truncated = result.subarray(0, result.length - 4);
      p.stdout.emit("data", Buffer.concat([frame(update), truncated]));
      p.stdout.emit("end");
      await expect(session).rejects.toMatchObject({
        code: "ACP_INCOMPLETE_FRAME",
        context: { trailingBytes: truncated.length },
      });
      expect(texts).toEqual([TEXT]);
      expect(p.killed).toBe(true);
    } finally {
      await closeAndConfirmExit(client, p);
    }
  });
});

const AGENT_FIXTURE = String.raw`
import readline from "node:readline";

const mode = process.argv[2];
const update = ${JSON.stringify(update)};
const frame = (value) => Buffer.from(JSON.stringify(value) + "\n", "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ASCII runs go out whole; every byte of a multi-byte code point is its own
// write with a pause, so the parent's pipe reads end inside code points.
async function writeSplit(bytes) {
  let run = [];
  for (const byte of bytes) {
    if (byte < 0x80) {
      run.push(byte);
      continue;
    }
    if (run.length > 0) process.stdout.write(Buffer.from(run));
    run = [];
    await sleep(15);
    process.stdout.write(Buffer.of(byte));
    await sleep(15);
  }
  if (run.length > 0) process.stdout.write(Buffer.from(run));
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  if (request.method === "initialize") {
    process.stdout.write(frame({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } }));
    continue;
  }
  if (request.method !== "session/new") {
    process.stdout.write(frame({ jsonrpc: "2.0", id: request.id, result: {} }));
    continue;
  }
  const result = frame({ jsonrpc: "2.0", id: request.id, result: { sessionId: update.params.sessionId } });
  if (mode === "split") {
    await writeSplit(Buffer.concat([frame(update), result]));
  } else if (mode === "eof-bytes") {
    process.stdout.write(Buffer.concat([frame(update), Buffer.from("🌿", "utf8").subarray(0, 2)]));
    process.stdout.end();
  } else if (mode === "eof-frame") {
    process.stdout.write(Buffer.concat([frame(update), result.subarray(0, result.length - 4)]));
    process.stdout.end();
  }
}
`;

describe("NativeAcpClient stdout over a real subprocess", () => {
  let root = "";
  let fixture = "";

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), "acp-utf8-subprocess-"));
    fixture = path.join(root, "agent.mjs");
    await writeFile(fixture, AGENT_FIXTURE);
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function startAgent(mode: "split" | "eof-bytes" | "eof-frame") {
    const recorder = recordTexts();
    const client = new NativeAcpClient({
      command: `${process.execPath} ${fixture} ${mode}`,
      cwd: root,
      approvalPreset: "autonomous",
      timeoutMs: 5_000,
      env: { PATH: process.env.PATH },
      onEvent: recorder.onEvent as never,
    });
    const spawnsBefore = spawnMock.mock.results.length;
    const started = client.start();
    const spawned = spawnMock.mock.results[spawnsBefore];
    if (spawned?.type !== "return") {
      throw new Error("NativeAcpClient did not spawn the fixture agent");
    }
    const child = spawned.value as ChildProcess;
    expect(child.pid).toEqual(expect.any(Number));
    // Chunks that begin with a continuation byte prove a pipe read ended
    // inside a code point.
    let chunksStartingMidCodePoint = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.length > 0 && chunk[0] >= 0x80 && chunk[0] < 0xc0) {
        chunksStartingMidCodePoint += 1;
      }
    });
    try {
      await started;
    } catch (error) {
      await client.close();
      throw error;
    }
    return {
      client,
      child,
      texts: recorder.texts,
      splitReads: () => chunksStartingMidCodePoint,
    };
  }

  it("reassembles code points split across real pipe reads", async () => {
    const { client, child, texts, splitReads } = await startAgent("split");
    try {
      await expect(client.createSession()).resolves.toMatchObject({
        sessionId: SESSION_ID,
      });
      expect(texts).toEqual([TEXT]);
      expect(splitReads()).toBeGreaterThan(0);
    } finally {
      await closeAndConfirmExit(client, child);
    }
  }, 15_000);

  it("dispatches the complete frame, then rejects incomplete UTF-8 bytes at EOF", async () => {
    const { client, child, texts } = await startAgent("eof-bytes");
    try {
      await expect(client.createSession()).rejects.toMatchObject({
        code: "ACP_INVALID_UTF8",
      });
      expect(texts).toEqual([TEXT]);
    } finally {
      await closeAndConfirmExit(client, child);
    }
  }, 15_000);

  it("dispatches the complete frame, then rejects an unterminated frame at EOF", async () => {
    const { client, child, texts } = await startAgent("eof-frame");
    try {
      await expect(client.createSession()).rejects.toMatchObject({
        code: "ACP_INCOMPLETE_FRAME",
      });
      expect(texts).toEqual([TEXT]);
    } finally {
      await closeAndConfirmExit(client, child);
    }
  }, 15_000);
});
