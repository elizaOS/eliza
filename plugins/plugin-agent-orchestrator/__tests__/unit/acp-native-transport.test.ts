import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NativeAcpClient,
  splitCommandLine,
} from "../../src/services/acp-native-transport.js";
import type { ApprovalPreset } from "../../src/services/types.js";

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

async function waitForSpawnCalls(count: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (spawnMock.mock.calls.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `expected ${count} spawn calls, got ${spawnMock.mock.calls.length}`,
  );
}

async function startClient(
  opts: Partial<ConstructorParameters<typeof NativeAcpClient>[0]> = {},
): Promise<{ client: NativeAcpClient; p: MockProc }> {
  const p = queueProc();
  const client = new NativeAcpClient({
    command: "agent-acp --flag",
    cwd: "/tmp/native-acp",
    approvalPreset: "autonomous",
    ...opts,
  });
  const started = client.start();
  await waitForWrites(p, 1);
  emitJson(p, { jsonrpc: "2.0", id: 1, result: {} });
  await started;
  return { client, p };
}

function writeAt(p: MockProc, index: number): Record<string, unknown> {
  return JSON.parse(p.stdinWrites[index] ?? "{}") as Record<string, unknown>;
}

function emitJson(p: MockProc, message: Record<string, unknown>): void {
  p.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
}

function closeProc(
  p: MockProc,
  code = 0,
  signal: NodeJS.Signals | null = null,
) {
  p.exitCode = code;
  p.signalCode = signal;
  p.emit("close", code, signal);
}

async function waitForResponse(
  p: MockProc,
  id: string | number,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    for (const write of p.stdinWrites) {
      const parsed = JSON.parse(write) as Record<string, unknown>;
      if (parsed.id === id && ("result" in parsed || "error" in parsed)) {
        return parsed;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`expected response for id ${String(id)}`);
}

function request(
  p: MockProc,
  id: string,
  method: string,
  params?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  emitJson(p, { jsonrpc: "2.0", id, method, params });
  return waitForResponse(p, id);
}

function clientForWorkspace(
  cwd: string,
  approvalPreset: ApprovalPreset = "autonomous",
): NativeAcpClient {
  return new NativeAcpClient({
    command: "unused",
    cwd,
    approvalPreset,
  });
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("NativeAcpClient JSON-RPC lifecycle", () => {
  it("sends JSON-RPC requests and resolves responses", async () => {
    const events: unknown[] = [];
    const p = queueProc();
    const client = new NativeAcpClient({
      command: "npx -y @zed-industries/codex-acp@0.14.0",
      cwd: "/tmp/native-acp",
      approvalPreset: "autonomous",
      terminal: false,
      onEvent: (event) => events.push(event),
    });

    const started = client.start();
    await waitForWrites(p, 1);
    expect(spawnMock).toHaveBeenCalledWith(
      "npx",
      ["-y", "@zed-industries/codex-acp@0.14.0"],
      expect.objectContaining({ cwd: "/tmp/native-acp" }),
    );
    expect(writeAt(p, 0)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientCapabilities: { terminal: false } },
    });
    emitJson(p, { jsonrpc: "2.0", id: 1, result: {} });
    await started;

    const created = client.createSession("/tmp/native-acp/work");
    await waitForWrites(p, 2);
    expect(writeAt(p, 1)).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: "/tmp/native-acp/work" },
    });
    emitJson(p, {
      jsonrpc: "2.0",
      id: 2,
      result: {
        sessionId: "protocol-session",
        _meta: { acp: { agentSessionId: "agent-session" } },
      },
    });

    await expect(created).resolves.toEqual({
      sessionId: "protocol-session",
      agentSessionId: "agent-session",
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: "initialize" }),
        expect.objectContaining({ method: "session/new" }),
        expect.objectContaining({ id: 2, result: expect.any(Object) }),
      ]),
    );
  });

  it("falls back from session/cancel request to notification when rejected", async () => {
    const { client, p } = await startClient();

    const cancelled = client.cancel("session-1");
    await waitForWrites(p, 2);
    expect(writeAt(p, 1)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "session/cancel",
      params: { sessionId: "session-1" },
    });

    emitJson(p, {
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32601, message: "Method not found" },
    });
    await waitForWrites(p, 3);
    expect(writeAt(p, 2)).toEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "session-1" },
    });
    await expect(cancelled).resolves.toBeUndefined();
  });

  it("triggers cancellation when a prompt request times out", async () => {
    vi.useFakeTimers();
    const { client, p } = await startClient({ timeoutMs: 10 });

    const timeoutResult = client
      .prompt("session-1", "keep going")
      .catch((error: unknown) => error);
    await waitForWrites(p, 2);
    expect(writeAt(p, 1)).toMatchObject({
      id: 2,
      method: "session/prompt",
      params: { sessionId: "session-1" },
    });

    await vi.advanceTimersByTimeAsync(10);
    await waitForWrites(p, 3);
    expect(writeAt(p, 2)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      method: "session/cancel",
      params: { sessionId: "session-1" },
    });
    const timeoutError = await timeoutResult;
    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).toBe(
      "ACP request timed out: session/prompt",
    );
    emitJson(p, { jsonrpc: "2.0", id: 3, result: {} });
  });

  it("returns method-not-found for unsupported client request methods", async () => {
    const { p } = await startClient();

    const response = await request(p, "unknown-1", "not/supported", {});

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: "unknown-1",
      error: {
        code: -32601,
        message: "Unsupported ACP client method: not/supported",
      },
    });
  });
});

describe("NativeAcpClient permission requests", () => {
  it("selects allow options for approved operations", async () => {
    const { p } = await startClient({ approvalPreset: "autonomous" });

    const response = await request(
      p,
      "permission-allow",
      "session/request_permission",
      {
        toolCall: { kind: "edit" },
        options: [
          { optionId: "deny", kind: "reject_once" },
          { optionId: "allow", kind: "allow_once" },
        ],
      },
    );

    expect(response).toMatchObject({
      id: "permission-allow",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });
  });

  it("selects deny options for rejected operations", async () => {
    const { p } = await startClient({ approvalPreset: "readonly" });

    const response = await request(
      p,
      "permission-deny",
      "session/request_permission",
      {
        toolCall: { kind: "edit" },
        options: [
          { optionId: "allow", kind: "allow_once" },
          { optionId: "deny", kind: "reject_once" },
        ],
      },
    );

    expect(response).toMatchObject({
      id: "permission-deny",
      result: { outcome: { outcome: "selected", optionId: "deny" } },
    });
  });

  it("returns cancelled when no compatible permission option exists", async () => {
    const { p } = await startClient({ approvalPreset: "readonly" });

    const response = await request(
      p,
      "permission-cancel",
      "session/request_permission",
      {
        toolCall: { kind: "edit" },
        options: [{ optionId: "allow", kind: "allow_once" }],
      },
    );

    expect(response).toMatchObject({
      id: "permission-cancel",
      result: { outcome: { outcome: "cancelled" } },
    });
  });
});

describe("NativeAcpClient workspace file actions", () => {
  it("serves filesystem read and write requests over JSON-RPC", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "native-acp-"));
    await writeFile(path.join(cwd, "notes.txt"), "line 1\nline 2\n", "utf8");
    const { p } = await startClient({ cwd, approvalPreset: "autonomous" });

    await expect(
      request(p, "fs-read", "fs/read_text_file", {
        path: "notes.txt",
        line: 1,
        limit: 1,
      }),
    ).resolves.toMatchObject({
      id: "fs-read",
      result: { content: "line 1" },
    });

    await expect(
      request(p, "fs-write", "fs/write_text_file", {
        path: "nested/out.txt",
        content: "saved",
      }),
    ).resolves.toMatchObject({
      id: "fs-write",
      result: {},
    });
    await expect(
      readFile(path.join(cwd, "nested/out.txt"), "utf8"),
    ).resolves.toBe("saved");
  });

  it("reads and writes relative paths inside the session cwd", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "native-acp-"));
    await writeFile(path.join(cwd, "notes.txt"), "line 1\nline 2\n", "utf8");
    const client = clientForWorkspace(cwd);

    await expect(
      (
        client as unknown as { readTextFile(params: unknown): Promise<unknown> }
      ).readTextFile({ path: "notes.txt", line: 2, limit: 1 }),
    ).resolves.toEqual({ content: "line 2" });

    await expect(
      (
        client as unknown as {
          writeTextFile(params: unknown): Promise<unknown>;
        }
      ).writeTextFile({ path: "nested/new.txt", content: "fresh" }),
    ).resolves.toEqual({});
    await expect(
      readFile(path.join(cwd, "nested/new.txt"), "utf8"),
    ).resolves.toBe("fresh");
  });

  it("rejects path traversal for reads and writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "native-acp-"));
    const cwd = path.join(root, "safe");
    await mkdir(cwd);
    await writeFile(path.join(root, "outside.txt"), "outside", "utf8");
    const client = clientForWorkspace(cwd);

    await expect(
      (
        client as unknown as { readTextFile(params: unknown): Promise<unknown> }
      ).readTextFile({ path: "../outside.txt" }),
    ).rejects.toThrow("outside the session workspace");

    await expect(
      (
        client as unknown as {
          writeTextFile(params: unknown): Promise<unknown>;
        }
      ).writeTextFile({ path: "../escape.txt", content: "nope" }),
    ).rejects.toThrow("outside the session workspace");
  });

  it("rejects symlink escapes for reads and writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "native-acp-"));
    const cwd = path.join(root, "safe");
    const outside = path.join(root, "outside");
    await mkdir(cwd);
    await mkdir(outside);
    await writeFile(path.join(outside, "secret.txt"), "secret", "utf8");
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(cwd, "read-link"),
    );
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(cwd, "write-link"),
    );
    const client = clientForWorkspace(cwd);

    await expect(
      (
        client as unknown as { readTextFile(params: unknown): Promise<unknown> }
      ).readTextFile({ path: "read-link" }),
    ).rejects.toThrow("outside the session workspace");

    await expect(
      (
        client as unknown as {
          writeTextFile(params: unknown): Promise<unknown>;
        }
      ).writeTextFile({ path: "write-link", content: "nope" }),
    ).rejects.toThrow("refusing to write through symlink");
  });
});

describe("NativeAcpClient terminal actions", () => {
  it("rejects terminal creation when the capability is disabled", async () => {
    const { p } = await startClient({ terminal: false });

    const response = await request(p, "terminal-disabled", "terminal/create", {
      command: "node",
    });

    expect(response).toMatchObject({
      id: "terminal-disabled",
      error: {
        code: -32071,
        message: "ACP terminal capability is disabled",
      },
    });
  });

  it("rejects terminal creation when execution is not approved", async () => {
    const { p } = await startClient({ approvalPreset: "standard" });

    const response = await request(p, "terminal-denied", "terminal/create", {
      command: "node",
    });

    expect(response).toMatchObject({
      id: "terminal-denied",
      error: {
        code: -32071,
        message: "Permission denied for terminal/create",
      },
    });
  });

  it("reports terminal output while running and includes exit status after close", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "native-acp-"));
    const agentProc = queueProc();
    const terminalProc = queueProc();
    const client = new NativeAcpClient({
      command: "agent-acp",
      cwd,
      approvalPreset: "autonomous",
    });
    const started = client.start();
    await waitForWrites(agentProc, 1);
    emitJson(agentProc, { jsonrpc: "2.0", id: 1, result: {} });
    await started;

    emitJson(agentProc, {
      jsonrpc: "2.0",
      id: "terminal-create",
      method: "terminal/create",
      params: { command: "node", args: ["-v"], cwd },
    });
    await waitForSpawnCalls(2);
    terminalProc.emit("spawn");
    const created = await waitForResponse(agentProc, "terminal-create");
    const terminalId = (created.result as { terminalId: string } | undefined)
      ?.terminalId;
    expect(terminalId).toEqual(expect.any(String));

    terminalProc.stdout.emit("data", Buffer.from("v20\n"));
    const running = await request(
      agentProc,
      "terminal-running",
      "terminal/output",
      {
        terminalId,
      },
    );
    expect(running).toMatchObject({
      id: "terminal-running",
      result: { output: "v20\n", truncated: false },
    });
    expect(running.result).not.toHaveProperty("exitStatus");

    closeProc(terminalProc, 7, null);
    const exited = await request(
      agentProc,
      "terminal-exited",
      "terminal/output",
      {
        terminalId,
      },
    );
    expect(exited).toMatchObject({
      id: "terminal-exited",
      result: {
        output: "v20\n",
        truncated: false,
        exitStatus: { exitCode: 7, signal: null },
      },
    });
  });
});

describe("splitCommandLine", () => {
  it("keeps quoted arguments together", () => {
    expect(splitCommandLine("npx -y 'pkg name' --flag \"two words\"")).toEqual({
      command: "npx",
      args: ["-y", "pkg name", "--flag", "two words"],
    });
  });
});
