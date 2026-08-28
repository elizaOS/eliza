/**
 * Covers the ACP session approval-mode negotiation added in #28401
 * ("fix: honor ACP coding approval mode").
 *
 * NativeAcpClient.createSession must map the configured approvalPreset onto
 * the agent's advertised ACP session modes and issue `session/set_mode`
 * only when the mode is actually available:
 *   - autonomous / permissive  -> "bypassPermissions"
 *   - readonly                 -> "plan"
 *   - anything else (default)  -> "dontAsk"
 *
 * This is a permission gate: the mode a sub-agent session runs under decides
 * whether it can bypass permission prompts. A regression that silently stops
 * negotiating (or negotiates the wrong mode) changes the trust boundary of
 * every ACP coding session, so the mapping and the availability guard are
 * pinned here as a behavioral contract.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  throw new Error(
    `expected ${count} stdin writes, got ${p.stdinWrites.length}`,
  );
}

function writeAt(p: MockProc, index: number): Record<string, unknown> {
  return JSON.parse(p.stdinWrites[index] ?? "{}") as Record<string, unknown>;
}

function emitJson(p: MockProc, message: Record<string, unknown>): void {
  p.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
}

type SessionNewResult = {
  sessionId?: string;
  modes?: unknown;
};

async function startClient(
  opts: Record<string, unknown> = {},
): Promise<{ client: NativeAcpClient; p: MockProc }> {
  const p = queueProc();
  const client = new NativeAcpClient({
    command: "agent-acp --flag",
    cwd: "/tmp/native-acp",
    approvalPreset: "autonomous",
    ...opts,
  } as never);
  const started = client.start();
  await waitForWrites(p, 1);
  emitJson(p, { jsonrpc: "2.0", id: 1, result: {} });
  await started;
  return { client, p };
}

function createSessionWithModes(
  client: NativeAcpClient,
  p: MockProc,
  result: SessionNewResult,
): Promise<unknown> {
  const created = client.createSession("/tmp/native-acp/work");
  return (async () => {
    await waitForWrites(p, 2);
    emitJson(p, {
      jsonrpc: "2.0",
      id: 2,
      result: { sessionId: "protocol-session", ...result },
    });
    return created;
  })();
}

afterEach(() => {
  spawnMock.mockReset();
});

describe("NativeAcpClient approval-mode negotiation (#28401)", () => {
  it("requests bypassPermissions when the autonomous preset is advertised", async () => {
    const { client, p } = await startClient();
    const created = createSessionWithModes(client, p, {
      modes: {
        availableModes: [
          { id: "dontAsk" },
          { id: "bypassPermissions" },
          { id: "plan" },
        ],
      },
    });
    await waitForWrites(p, 3);
    expect(writeAt(p, 2)).toMatchObject({
      jsonrpc: "2.0",
      method: "session/set_mode",
      params: { sessionId: "protocol-session", modeId: "bypassPermissions" },
    });
    emitJson(p, { jsonrpc: "2.0", id: 3, result: {} });
    await expect(created).resolves.toEqual({
      sessionId: "protocol-session",
      agentSessionId: undefined,
    });
  });

  it("requests bypassPermissions for the permissive preset", async () => {
    const { client, p } = await startClient({ approvalPreset: "permissive" });
    const created = createSessionWithModes(client, p, {
      modes: { availableModes: [{ id: "bypassPermissions" }] },
    });
    await waitForWrites(p, 3);
    expect(writeAt(p, 2)).toMatchObject({
      method: "session/set_mode",
      params: { modeId: "bypassPermissions" },
    });
    emitJson(p, { jsonrpc: "2.0", id: 3, result: {} });
    await expect(created).resolves.toMatchObject({
      sessionId: "protocol-session",
    });
  });

  it("requests plan mode for the readonly preset", async () => {
    const { client, p } = await startClient({ approvalPreset: "readonly" });
    const created = createSessionWithModes(client, p, {
      modes: { availableModes: [{ id: "plan" }, { id: "dontAsk" }] },
    });
    await waitForWrites(p, 3);
    expect(writeAt(p, 2)).toMatchObject({
      method: "session/set_mode",
      params: { sessionId: "protocol-session", modeId: "plan" },
    });
    emitJson(p, { jsonrpc: "2.0", id: 3, result: {} });
    await expect(created).resolves.toMatchObject({
      sessionId: "protocol-session",
    });
  });

  it("requests dontAsk mode for the default (standard) preset", async () => {
    const { client, p } = await startClient({ approvalPreset: "standard" });
    const created = createSessionWithModes(client, p, {
      modes: { availableModes: [{ id: "dontAsk" }] },
    });
    await waitForWrites(p, 3);
    expect(writeAt(p, 2)).toMatchObject({
      method: "session/set_mode",
      params: { sessionId: "protocol-session", modeId: "dontAsk" },
    });
    emitJson(p, { jsonrpc: "2.0", id: 3, result: {} });
    await expect(created).resolves.toMatchObject({
      sessionId: "protocol-session",
    });
  });

  it("skips set_mode when the requested mode is not advertised", async () => {
    const { client, p } = await startClient();
    const created = createSessionWithModes(client, p, {
      modes: { availableModes: [{ id: "plan" }, { id: "dontAsk" }] },
    });
    await expect(created).resolves.toMatchObject({
      sessionId: "protocol-session",
    });
    // session/new is the last write; no session/set_mode follows.
    expect(p.stdinWrites).toHaveLength(2);
  });

  it("skips set_mode when the agent reports no modes (legacy agents)", async () => {
    const { client, p } = await startClient();
    const created = createSessionWithModes(client, p, {});
    await expect(created).resolves.toMatchObject({
      sessionId: "protocol-session",
    });
    expect(p.stdinWrites).toHaveLength(2);
  });

  it("treats string-mode advertisements as unsupported (no set_mode)", async () => {
    // The ACP modes.availableModes contract is an object array with string
    // `id`s; a string-array advertisement is not recognized, so negotiation
    // is skipped rather than sending an unvalidated mode id.
    const { client, p } = await startClient();
    const created = createSessionWithModes(client, p, {
      modes: { availableModes: ["bypassPermissions"] },
    });
    await expect(created).resolves.toMatchObject({
      sessionId: "protocol-session",
    });
    expect(p.stdinWrites).toHaveLength(2);
  });

  it("filters non-object and non-string mode entries before matching", async () => {
    const { client, p } = await startClient({ approvalPreset: "readonly" });
    const created = createSessionWithModes(client, p, {
      modes: {
        availableModes: [{ id: "plan" }, { id: 42 }, null, "bypassPermissions"],
      },
    });
    await waitForWrites(p, 3);
    expect(writeAt(p, 2)).toMatchObject({
      method: "session/set_mode",
      params: { sessionId: "protocol-session", modeId: "plan" },
    });
    emitJson(p, { jsonrpc: "2.0", id: 3, result: {} });
    await expect(created).resolves.toMatchObject({
      sessionId: "protocol-session",
    });
  });
});
