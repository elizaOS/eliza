import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditDispatcher, AuditEvent, EmitInput } from "@elizaos/security";
import { ClaudeCodeSubAgentService } from "./sub-agent-service.js";

const originalSpawn = Bun.spawn;
let spawned: SpawnCall[] = [];
let proc: MockProc;

type SpawnCall = {
  cmd: string[];
  cwd?: string;
  env?: Record<string, string>;
};

type MockProc = {
  stdin: { writes: string[]; write: (data: string) => void };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: ReturnType<typeof mock>;
};

function makeProc(chunks: string[] = []): MockProc {
  const encoder = new TextEncoder();
  return {
    stdin: {
      writes: [],
      write(data: string) {
        this.writes.push(data);
      },
    },
    stdout: new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
          await Promise.resolve();
        }
        controller.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>(),
    kill: mock(() => undefined),
  };
}

function auditSink() {
  const events: EmitInput[] = [];
  const dispatcher = {
    emit: async (event: EmitInput) => {
      events.push(event);
      return {
        event_id: `event-${events.length}`,
        ts: "2026-01-01T00:00:00.000Z",
        ...event,
      } as AuditEvent;
    },
  } as unknown as AuditDispatcher;
  return { dispatcher, events };
}

async function settleStdoutPump(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("ClaudeCodeSubAgentService", () => {
  beforeEach(() => {
    spawned = [];
    proc = makeProc();
    (Bun as typeof Bun & { spawn: typeof originalSpawn }).spawn = mock(
      (options: unknown) => {
        const spawnOptions = options as SpawnCall;
        spawned.push(spawnOptions);
        return proc as unknown as ReturnType<typeof Bun.spawn>;
      },
    ) as unknown as typeof originalSpawn;
  });

  afterEach(() => {
    (Bun as typeof Bun & { spawn: typeof originalSpawn }).spawn = originalSpawn;
  });

  it("spawns a session with safe cwd, filtered env, audit event, and initial prompt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-service-"));
    const { dispatcher, events } = auditSink();
    process.env.ANTHROPIC_API_KEY = "must-not-forward";
    process.env.PATH = "/usr/bin";

    const service = new ClaudeCodeSubAgentService({
      workspaceRoots: [cwd],
      auditDispatcher: dispatcher,
      actorId: "user-1",
    });

    const result = (await service.createSession({
      cwd,
      binary: "env",
      model: "claude-test",
      initialPrompt: "inspect src",
      extraEnv: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" },
    })) as { sessionId: string; sandbox: string };

    expect(result.sessionId).toStartWith("cc-");
    expect(spawned).toHaveLength(1);
    const spawnOptions = spawned[0] as Required<SpawnCall>;
    expect(spawnOptions.cwd).toBe(cwd);
    expect(spawnOptions.cmd).toContain("/usr/bin/env");
    expect(spawnOptions.cmd).toContain("--print");
    expect(spawnOptions.cmd).toContain("--model");
    expect(spawnOptions.cmd).toContain("claude-test");
    expect(spawnOptions.env.ANTHROPIC_BASE_URL).toBe(
      "https://api.anthropic.com",
    );
    expect("ANTHROPIC_API_KEY" in spawnOptions.env).toBe(false);
    expect(proc.stdin.writes).toEqual(["inspect src\n"]);
    expect(events[0]).toMatchObject({
      actor: { type: "user", id: "user-1" },
      action: "agent.spawn",
      result: "success",
      resource: { type: "sub-agent.session", id: result.sessionId },
      metadata: {
        session_id: result.sessionId,
        binary: "/usr/bin/env",
        cwd,
        sandbox: result.sandbox,
      },
    });
  });

  it("buffers stdout lines and only drains since-last cursors on request", async () => {
    proc = makeProc(["a\nb", " c\n"]);
    const cwd = mkdtempSync(join(tmpdir(), "cc-service-"));
    const service = new ClaudeCodeSubAgentService({ workspaceRoots: [cwd] });

    const { sessionId } = (await service.createSession({
      cwd,
      binary: "env",
    })) as { sessionId: string };
    await settleStdoutPump();

    await expect(
      service.getOutput({ sessionId, mode: "all" }),
    ).resolves.toEqual({ lines: ["a", "b c"] });
    await expect(
      service.getOutput({ sessionId, mode: "since-last" }),
    ).resolves.toEqual({ lines: ["a", "b c"] });
    await expect(
      service.getOutput({ sessionId, mode: "since-last" }),
    ).resolves.toEqual({ lines: [] });
    await expect(
      service.getOutput({ sessionId, mode: "all" }),
    ).resolves.toEqual({ lines: ["a", "b c"] });
  });

  it("terminates sessions, finalizes audit exactly once, and handles unknown sessions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cc-service-"));
    const { dispatcher, events } = auditSink();
    const service = new ClaudeCodeSubAgentService({
      workspaceRoots: [cwd],
      auditDispatcher: dispatcher,
    });
    const { sessionId } = (await service.createSession({
      cwd,
      binary: "env",
    })) as { sessionId: string };

    await expect(service.listSessions()).resolves.toMatchObject({
      sessions: [{ sessionId, cwd, model: null }],
    });
    await expect(service.terminate({ sessionId })).resolves.toEqual({
      terminated: true,
    });
    await expect(service.terminate({ sessionId })).resolves.toEqual({
      terminated: false,
    });
    await expect(service.listSessions()).resolves.toEqual({ sessions: [] });

    expect(proc.kill).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.action === "agent.spawn"),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.action === "agent.session_record"),
    ).toHaveLength(1);
  });

  it("stop kills and finalizes every active session then clears service state", async () => {
    const firstProc = makeProc();
    const secondProc = makeProc();
    const procs = [firstProc, secondProc];
    (Bun as typeof Bun & { spawn: typeof originalSpawn }).spawn = mock(
      (options: unknown) => {
        spawned.push(options as SpawnCall);
        return procs.shift() as unknown as ReturnType<typeof Bun.spawn>;
      },
    ) as unknown as typeof originalSpawn;

    const cwd = mkdtempSync(join(tmpdir(), "cc-service-"));
    const { dispatcher, events } = auditSink();
    const service = new ClaudeCodeSubAgentService({
      workspaceRoots: [cwd],
      auditDispatcher: dispatcher,
    });
    await service.createSession({ cwd, binary: "env" });
    await service.createSession({ cwd, binary: "env" });

    await service.stop();

    expect(firstProc.kill).toHaveBeenCalledTimes(1);
    expect(secondProc.kill).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.action === "agent.session_record"),
    ).toHaveLength(2);
    await expect(service.listSessions()).resolves.toEqual({ sessions: [] });
  });
});
