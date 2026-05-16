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

async function waitForSessionStatus(
  service: AcpService,
  sessionId: string,
  status: string,
  timeoutMs = 4000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const session = await service.getSession(sessionId);
    if (session?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const session = await service.getSession(sessionId);
  throw new Error(
    `expected session ${sessionId} to reach ${status}, got ${session?.status}`,
  );
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

    const store = Reflect.get(service, "store") as { backend: string };
    expect(store.backend).toBe("runtime-db");
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
    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(args).not.toContain("--no-terminal");
  });

  it("honors explicit terminal capability opt-out", async () => {
    const reg = nextProc();
    const service = new AcpService(runtime({ ELIZA_ACP_NO_TERMINAL: "true" }));
    await service.start();

    const promise = service.spawnSession({
      name: "no-terminal",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    closeOk(reg);
    await promise;

    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(args).toContain("--no-terminal");
  });

  it("does not emit task_complete from the session creation command", async () => {
    const reg = nextProc();
    const service = new AcpService(runtime());
    const events: string[] = [];
    const taskCompletePayloads: Array<{ response?: string }> = [];
    service.onSessionEvent((_sid, event, payload) => {
      events.push(event);
      if (event === "task_complete") {
        taskCompletePayloads.push(payload as { response?: string });
      }
    });
    await service.start();

    const promise = service.spawnSession({
      name: "create-only",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    reg.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":"create","result":{"stopReason":"end_turn"},"sessionId":"protocol-session"}\n',
      ),
    );
    closeOk(reg);
    await promise;

    expect(events).toContain("ready");
    expect(events).not.toContain("task_complete");
  });

  it("prepares OpenCode ACP environment for Cerebras", async () => {
    const reg = nextProc();
    const service = new AcpService(
      runtime({
        ELIZA_OPENCODE_BASE_URL: "https://api.cerebras.ai/v1",
        ELIZA_OPENCODE_API_KEY: "csk_test",
        ELIZA_OPENCODE_MODEL_POWERFUL: "gpt-oss-120b",
      }),
    );
    await service.start();

    const spawned = service.spawnSession({
      name: "opencode-cerebras",
      agentType: "opencode",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    closeOk(reg);
    await spawned;

    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    const agentArgIndex = args?.indexOf("--agent") ?? -1;
    expect(agentArgIndex).toBeGreaterThanOrEqual(0);
    expect(args?.[agentArgIndex + 1]).toMatch(
      /plugin-agent-orchestrator\/bin.*opencode.* acp$/,
    );
    expect(args).not.toContain("opencode");

    const env = spawnMock.mock.calls[0]?.[2]?.env as
      | Record<string, string>
      | undefined;
    const config = JSON.parse(env?.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      provider?: Record<
        string,
        { npm?: string; options?: { baseURL?: string; apiKey?: string } }
      >;
      model?: string;
    };
    expect(env?.OPENCODE_MODEL).toBe("cerebras/gpt-oss-120b");
    expect(env?.OPENCODE_DISABLE_AUTOUPDATE).toBe("1");
    expect(config.model).toBe("cerebras/gpt-oss-120b");
    expect(config.provider?.cerebras?.options?.baseURL).toBe(
      "https://api.cerebras.ai/v1",
    );
    expect(config.provider?.cerebras?.npm).toBe("@ai-sdk/cerebras");
    expect(config.provider?.cerebras?.options?.apiKey).toBe("csk_test");
  });

  it("normalizes BENCHMARK_TASK_AGENT=elizaos to the OpenCode ACP adapter", async () => {
    const reg = nextProc();
    const service = new AcpService(
      runtime({
        BENCHMARK_TASK_AGENT: "elizaos",
        CEREBRAS_API_KEY: "csk_test",
        CEREBRAS_MODEL: "gpt-oss-120b",
      }),
    );
    await service.start();

    const spawned = service.spawnSession({
      name: "benchmark-elizaos",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    closeOk(reg);
    const session = await spawned;

    expect(session.agentType).toBe("opencode");
    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    expect(args).not.toContain("elizaos");

    const env = spawnMock.mock.calls[0]?.[2]?.env as
      | Record<string, string>
      | undefined;
    expect(env?.OPENCODE_MODEL).toBe("cerebras/gpt-oss-120b");
  });

  it("uses an explicit OpenCode ACP command override when configured", async () => {
    const reg = nextProc();
    const service = new AcpService(
      runtime({
        ELIZA_OPENCODE_ACP_COMMAND: "/opt/opencode/bin/opencode acp",
      }),
    );
    await service.start();

    const spawned = service.spawnSession({
      name: "opencode-command",
      agentType: "opencode",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(reg);
    closeOk(reg);
    const { sessionId } = await spawned;

    const args = spawnMock.mock.calls[0]?.[1] as string[] | undefined;
    const agentArgIndex = args?.indexOf("--agent") ?? -1;
    expect(agentArgIndex).toBeGreaterThanOrEqual(0);
    expect(args?.[agentArgIndex + 1]).toBe("/opt/opencode/bin/opencode acp");
    expect(args).not.toContain("opencode");

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "write a tiny static page");
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        '{"jsonrpc":"2.0","id":"prompt","result":{"stopReason":"end_turn"},"sessionId":"protocol-session"}\n',
      ),
    );
    closeOk(prompt);
    await sent;

    const promptArgs = spawnMock.mock.calls[1]?.[1] as string[] | undefined;
    const promptAgentArgIndex = promptArgs?.indexOf("--agent") ?? -1;
    expect(promptAgentArgIndex).toBeGreaterThanOrEqual(0);
    expect(promptArgs?.[promptAgentArgIndex + 1]).toBe(
      "/opt/opencode/bin/opencode acp",
    );
    expect(promptArgs).not.toContain("opencode");
  });

  it("sendPrompt emits message, tool_running, task_complete, stopped and resolves PromptResult", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    const events: string[] = [];
    const taskCompletePayloads: Array<{ response?: string }> = [];
    service.onSessionEvent((_sid, event, payload) => {
      events.push(event);
      if (event === "task_complete") {
        taskCompletePayloads.push(payload as { response?: string });
      }
    });
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
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","title":"Running tool","rawOutput":"{\\"output\\":\\"Filesystem      Size  Used Avail Use% Mounted on\\\\n/dev/root        45G   38G  7.0G  84% /\\",\\"metadata\\":{\\"exitCode\\":0}}"}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","update":{"sessionUpdate":"tool_call_update","toolCallId":"t2","status":"completed","title":"Read home usage","content":{"type":"text","text":"/home            387G  223G  165G  58% /home"}}}}\n`,
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
    expect(result.response).toContain("done");
    expect(result.response).toContain("[tool output: Running tool]");
    expect(result.response).toContain("/dev/root        45G");
    expect(result.response).toContain("[/tool output]");
    expect(result.response).toContain("[tool output: Read home usage]");
    expect(result.response).toContain("/home            387G");
    expect(result.response).not.toContain('"metadata"');
    expect(taskCompletePayloads[0]?.response).toBe(result.response);
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

  it("closes one-shot initialTask sessions after completion", async () => {
    const create = nextProc();
    const prompt = nextProc();
    const close = nextProc();
    const service = new AcpService(runtime());
    await service.start();

    const spawned = service.spawnSession({
      name: "one-shot",
      agentType: "codex",
      workdir: "/tmp/acp-test",
      initialTask: "write the app",
      metadata: { keepAliveAfterComplete: false },
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"prompt","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);

    await waitForSpawn(close);
    closeOk(close);

    await waitForSessionStatus(service, sessionId, "stopped");
    expect(spawnMock).toHaveBeenCalledTimes(3);
  });

  it("keeps initialTask sessions open when keepAliveAfterComplete is true", async () => {
    const create = nextProc();
    const prompt = nextProc();
    const service = new AcpService(runtime());
    await service.start();

    const spawned = service.spawnSession({
      name: "keep-alive",
      agentType: "codex",
      workdir: "/tmp/acp-test",
      initialTask: "write the app",
      metadata: { keepAliveAfterComplete: true },
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"prompt","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);

    await waitForSessionStatus(service, sessionId, "ready");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it("passes route-prefixed prompts after an end-of-options marker", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({
      name: "route-prefixed",
      agentType: "opencode",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const text = "--- Resolved Workspace ---\nDo the task.";
    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, text);
    await waitForSpawn(prompt);

    const args = spawnMock.mock.calls.at(-1)?.[1] as string[] | undefined;
    expect(args?.slice(-2)).toEqual(["--", text]);

    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"req-route","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);
    await sent;
  });

  it("does not treat unclassified text update echoes as prompt output", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({
      name: "ignore-echo",
      agentType: "opencode",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(
      sessionId,
      "build https://example.test/app",
    );
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","content":{"type":"text","text":"build https://example.test/app"}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done"}}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"req-echo","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);

    const result = await sent;
    expect(result.response).toBe("done");
  });

  it("accepts direct assistant text updates when adapters provide a role", async () => {
    const create = nextProc();
    const service = new AcpService(runtime());
    await service.start();
    const spawned = service.spawnSession({
      name: "assistant-direct",
      agentType: "codex",
      workdir: "/tmp/acp-test",
    });
    await waitForSpawn(create);
    closeOk(create);
    const { sessionId } = await spawned;

    const prompt = nextProc();
    const sent = service.sendPrompt(sessionId, "do the thing");
    await waitForSpawn(prompt);
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"${sessionId}","role":"assistant","content":{"type":"text","text":"direct done"}}}\n`,
      ),
    );
    prompt.proc.stdout.emit(
      "data",
      Buffer.from(
        `{"jsonrpc":"2.0","id":"req-direct","result":{"stopReason":"end_turn"},"sessionId":"${sessionId}"}\n`,
      ),
    );
    closeOk(prompt);

    const result = await sent;
    expect(result.response).toBe("direct done");
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
    const store = Reflect.get(service, "store") as {
      update: (id: string, patch: unknown) => Promise<void>;
    };
    await store.update(sessionId, { pid: 999999 });

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
