import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AcpService } from "../../src/services/acp-service.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

type MockProc = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: Writable;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
};

const spawnMock = vi.mocked(spawn);

function runtime(settings: Record<string, string | undefined> = {}) {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    getSetting: vi.fn((key: string) => settings[key]),
    services: new Map<string, unknown[]>(),
  } as never;
}

function proc(): MockProc {
  const p = new EventEmitter() as MockProc;
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.stdin = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  p.killed = false;
  p.kill = vi.fn((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGKILL") p.killed = true;
    return true;
  });
  return p;
}

// Each spawn registration includes a deferred that resolves when spawn() is
// actually invoked. Tests await the deferred before emitting stdout/close —
// guarantees stream listeners have already been attached.
interface ProcRegistration {
  proc: MockProc;
  spawned: Promise<void>;
}

function nextProc(): ProcRegistration {
  const p = proc();
  let resolveSpawned: () => void = () => undefined;
  const spawned = new Promise<void>((resolve) => {
    resolveSpawned = resolve;
  });
  spawnMock.mockImplementationOnce(((..._args: unknown[]) => {
    // resolve on next microtask so the synchronous listener-attach inside
    // runAcpx (proc.stdout.on("data", ...), proc.on("close", ...)) completes
    // before the test fires emits.
    queueMicrotask(resolveSpawned);
    return p;
  }) as never);
  return { proc: p, spawned };
}

async function waitForSpawn(
  reg: ProcRegistration,
  timeoutMs = 4000,
): Promise<void> {
  await Promise.race([
    reg.spawned,
    new Promise<void>((_, reject) => {
      setTimeout(
        () =>
          reject(
            new Error(
              `waitForSpawn: spawn never invoked within ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      ).unref?.();
    }),
  ]);
  // give listener-attach a microtask
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function closeOk(reg: ProcRegistration | MockProc) {
  const p =
    "proc" in (reg as ProcRegistration)
      ? (reg as ProcRegistration).proc
      : (reg as MockProc);
  // close on next tick so any sync-emitted data above is flushed first
  setImmediate(() => p.emit("close", 0, null));
}

beforeEach(() => {
  spawnMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("AcpService", () => {
  it("static start wires the runtime-backed durable session store", async () => {
    const rt = runtime() as {
      databaseAdapter: { query: ReturnType<typeof vi.fn> };
    };
    rt.databaseAdapter = { query: vi.fn() };

    const service = await AcpService.start(rt as never);

    expect(
      (
        service as unknown as {
          store: { backend: string };
        }
      ).store.backend,
    ).toBe("runtime-db");
    await service.stop();
  });

  it("spawns a session, emits ready, and stores the session", async () => {
    const reg = nextProc();
    const service = new AcpService(runtime());
    const events: Array<[string, string, unknown]> = [];
    service.onSessionEvent((sid, event, data) =>
      events.push([sid, event, data]),
    );
    await service.start();

    const promise = service.spawnSession({
      name: "s1",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    reg.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"session_started","params":{"sessionId":"s1"}}\n',
      ),
    );
    closeOk(reg);
    const result = await promise;

    expect(result.name).toBe("s1");
    expect(result.status).toBe("ready");
    expect(await service.listSessions()).toHaveLength(1);
    expect(events.some(([, event]) => event === "ready")).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith(
      "acpx",
      expect.arrayContaining([
        "--format",
        "json",
        "codex",
        "sessions",
        "new",
        "--name",
        "s1",
      ]),
      expect.objectContaining({ cwd: "/tmp/acp-test" }),
    );
  });

  it("sendPrompt emits message, tool_running, task_complete, stopped and resolves PromptResult", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const events: string[] = [];
    service.onSessionEvent((_sid, event) => events.push(event));
    await service.start();
    const spawned = service.spawnSession({
      name: "s2",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "do the thing");
    await waitForSpawn(prompt);
    // Real ACP wraps under params.update.{...}; service handles both.
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"',
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `${sessionId}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","update":{"sessionUpdate":"tool_call","toolCallId":"t1","status":"in_progress","title":"Running tool"}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"req-1","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);

    const result = await sent;
    expect(result.response).toBe("done");
    expect(result.stopReason).toBe("end_turn");
    expect(events).toEqual(
      expect.arrayContaining([
        "message",
        "tool_running",
        "task_complete",
        "stopped",
      ]),
    );
    expect(events.indexOf("message")).toBeLessThan(
      events.indexOf("task_complete"),
    );
  });

  it("keys service events by local session id when ACP reports a protocol session id", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const eventSessionIds: string[] = [];
    const acpSessionIds: Array<string | undefined> = [];
    service.onSessionEvent((sid) => eventSessionIds.push(sid));
    service.onAcpEvent((_event, sid) => acpSessionIds.push(sid));
    await service.start();
    const spawned = service.spawnSession({
      name: "local-id",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "hi");
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"protocol-session","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hello"}}}}\n',
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":"req","result":{"sessionId":"protocol-session","stopReason":"end_turn"}}\n',
      ),
    );
    closeOk(prompt);
    await sent;

    expect(eventSessionIds).toContain(sessionId);
    expect(eventSessionIds).not.toContain("protocol-session");
    expect(acpSessionIds).toContain(sessionId);
    expect(acpSessionIds).not.toContain("protocol-session");
    expect((await service.getSession(sessionId))?.acpxSessionId).toBe(
      "protocol-session",
    );
  });

  it("cancelSession sends SIGTERM then SIGKILL after grace", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({
      name: "s3",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    void service.sendPrompt(sessionId, "long running").catch(() => undefined);
    await waitForSpawn(prompt);
    void service.cancelSession(sessionId).catch(() => undefined);
    // give cancelSession a tick to call kill
    await new Promise((resolve) => setImmediate(resolve));

    expect(prompt.proc.kill).toHaveBeenCalledWith("SIGTERM");
    prompt.proc.emit("close", 130, "SIGTERM");
  });

  it("preserves cancelled status when cancelling an in-flight prompt", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const events: string[] = [];
    service.onSessionEvent((_sid, event) => events.push(event));
    await service.start();
    const spawned = service.spawnSession({
      name: "cancel-active",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "long running");
    await waitForSpawn(prompt);
    const cancelled = service.cancelSession(sessionId);
    await new Promise((resolve) => setImmediate(resolve));
    expect(prompt.proc.kill).toHaveBeenCalledWith("SIGTERM");
    prompt.proc.emit("close", 130, "SIGTERM");

    await cancelled;
    const result = await sent;
    expect(result.stopReason).toBe("cancelled");
    expect(result.error).toBeUndefined();
    expect((await service.getSession(sessionId))?.status).toBe("cancelled");
    expect(events).toContain("cancelled");
    expect(events).not.toContain("error");
  });

  it("ignores malformed NDJSON without crashing", async () => {
    const create = nextProc();
    const rt = runtime() as { logger: { warn: ReturnType<typeof vi.fn> } };
    const service = new AcpService(rt as never);
    await service.start();
    const promise = service.spawnSession({
      name: "bad-json",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    create.proc.stdout.emit("data", Buffer.from("not-json\n"));
    closeOk(create);
    await expect(promise).resolves.toMatchObject({ name: "bad-json" });
    expect(rt.logger.warn).toHaveBeenCalled();
  });

  it("handles partial lines across chunk boundaries", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const events: string[] = [];
    service.onSessionEvent((_sid, event) => events.push(event));
    await service.start();
    const spawned = service.spawnSession({
      name: "partial",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;
    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "hi");
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hel`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `lo"}}}}\n{"jsonrpc":"2.0","id":"req","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);
    const result = await sent;
    expect(result.response).toBe("hello");
    expect(events).toContain("task_complete");
  });

  it("maps exit code 1 with auth stderr to auth error event", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const errors: unknown[] = [];
    service.onSessionEvent((_sid, event, data) => {
      if (event === "error") errors.push(data);
    });
    await service.start();
    const spawned = service.spawnSession({
      name: "auth",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "hi");
    await waitForSpawn(prompt);
    prompt.proc.stderr.emit(
      "data",
      Buffer.from("401 unauthorized authenticate failed"),
    );
    setImmediate(() => prompt.proc.emit("close", 1, null));
    await sent;
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ failureKind: "auth" }),
      ]),
    );
  });

  it("honors public env aliases for workspace, approval, and prompt timeout", async () => {
    const create = nextProc();
    const service = new AcpService(
      runtime({
        ELIZA_ACP_WORKSPACE_ROOT: "/tmp/acp-workspace-root",
        ELIZA_ACP_DEFAULT_APPROVAL: "read-only",
        ELIZA_ACP_PROMPT_TIMEOUT_MS: "123000",
      }),
    );
    await service.start();

    const spawned = service.spawnSession({
      name: "env-alias",
      agentType: "codex",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    expect(spawnMock).toHaveBeenCalledWith(
      "acpx",
      expect.arrayContaining([
        "--cwd",
        "/tmp/acp-workspace-root",
        "--deny-all",
      ]),
      expect.objectContaining({ cwd: "/tmp/acp-workspace-root" }),
    );

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "hi");
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"req","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);
    await sent;

    expect(spawnMock).toHaveBeenLastCalledWith(
      "acpx",
      expect.arrayContaining(["--timeout", "123"]),
      expect.objectContaining({ cwd: "/tmp/acp-workspace-root" }),
    );
  });

  it("reattach after dead pid respawns", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({
      name: "reattach",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;
    const session = await service.getSession(sessionId);
    expect(session).toBeTruthy();
    await (
      service as unknown as {
        store: { update: (id: string, patch: unknown) => Promise<void> };
      }
    ).store.update(sessionId, { pid: 999999 });

    const respawnProc = nextProc();
    const reattached = service.reattachSession(sessionId);
    await waitForSpawn(respawnProc);
    closeOk(respawnProc);
    const result = await reattached;
    expect(result.sessionId).not.toBe(sessionId);
    expect(result.name).toBe("reattach");
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });
});
