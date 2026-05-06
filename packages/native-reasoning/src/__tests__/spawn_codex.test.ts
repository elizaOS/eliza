/**
 * Tests for Wave 1.C `spawn_codex` tool.
 *
 * The tool wraps plugin-agent-orchestrator's CREATE_TASK action plus
 * PTY_SERVICE event subscription. We mock both surfaces.
 */

import type { Action, IAgentRuntime, Memory } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  generateDefaultWorkdir,
  handler,
  safeError,
  tool,
} from "../tools/spawn_codex.js";

type SessionEventCb = (sid: string, event: string, data: unknown) => void;

interface MockPtyService {
  cbs: SessionEventCb[];
  onSessionEvent: (cb: SessionEventCb) => () => void;
  emit: (sid: string, event: string, data?: unknown) => void;
}

function makePty(): MockPtyService {
  const cbs: SessionEventCb[] = [];
  return {
    cbs,
    onSessionEvent(cb) {
      cbs.push(cb);
      return () => {
        const idx = cbs.indexOf(cb);
        if (idx !== -1) cbs.splice(idx, 1);
      };
    },
    emit(sid, event, data = {}) {
      for (const cb of [...cbs]) cb(sid, event, data);
    },
  };
}

interface BuildRuntimeOpts {
  action?: Partial<Action> | null;
  pty?: MockPtyService | null;
}

function buildRuntime(opts: BuildRuntimeOpts = {}): IAgentRuntime {
  const action: Action | null =
    opts.action === null
      ? null
      : ({
          name: "CREATE_TASK",
          description: "",
          similes: [],
          examples: [],
          handler: vi.fn(),
          validate: vi.fn(async () => true),
          ...(opts.action ?? {}),
        } as unknown as Action);
  const actions = action ? [action] : [];
  const services = new Map<string, unknown>();
  if (opts.pty !== null) {
    services.set("PTY_SERVICE", opts.pty ?? makePty());
  }
  return {
    agentId: "00000000-0000-0000-0000-000000000001",
    actions,
    getService: (name: string) => services.get(name) ?? null,
  } as unknown as IAgentRuntime;
}

const fakeMessage = (): Memory =>
  ({
    id: "00000000-0000-0000-0000-000000000aaa",
    roomId: "00000000-0000-0000-0000-000000000bbb",
    entityId: "00000000-0000-0000-0000-000000000ccc",
    agentId: "00000000-0000-0000-0000-000000000001",
    content: { text: "parent message" },
  }) as unknown as Memory;

describe("spawn_codex schema", () => {
  it("declares a custom tool with required task field", () => {
    expect(tool.type).toBe("custom");
    expect(tool.name).toBe("spawn_codex");
    expect(tool.input_schema.required).toEqual(["task"]);
  });

  it("safeError formats consistently", () => {
    expect(safeError("boom")).toEqual({
      content: "subagent failed: boom",
      is_error: true,
    });
  });

  it("generateDefaultWorkdir lives under /workspace/tasks", () => {
    const wd = generateDefaultWorkdir(new Date(0));
    expect(wd.startsWith("/workspace/tasks/")).toBe(true);
    expect(wd).toMatch(/^\/workspace\/tasks\/19700101-000000-[0-9a-f]{8}$/);
  });
});

describe("spawn_codex input validation", () => {
  it("rejects missing task", async () => {
    const res = await handler({}, buildRuntime(), fakeMessage());
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/'task' is required/);
  });

  it("rejects empty task", async () => {
    const res = await handler({ task: "   " }, buildRuntime(), fakeMessage());
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/'task' is required/);
  });
});

describe("spawn_codex missing dependencies", () => {
  it("returns is_error when CREATE_TASK is not registered", async () => {
    const runtime = {
      agentId: "x",
      actions: [],
      getService: () => makePty(),
    } as unknown as IAgentRuntime;
    const res = await handler({ task: "do something" }, runtime, fakeMessage());
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/CREATE_TASK action not registered/);
  });

  it("returns is_error when PTY_SERVICE is missing", async () => {
    const runtime = buildRuntime({ pty: null });
    const res = await handler({ task: "do something" }, runtime, fakeMessage());
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/PTY_SERVICE is not available/);
  });
});

describe("spawn_codex happy path", () => {
  let pty: MockPtyService;

  beforeEach(() => {
    pty = makePty();
  });

  it("invokes CREATE_TASK with agentType=codex and waits for task_complete", async () => {
    const actionHandler = vi.fn(async (_rt, _msg, _state, _opts, _cb) => {
      // Synchronously emit task_complete so the wait resolves quickly
      // after the settle window. Use setImmediate to fire after the
      // caller has subscribed via track().
      setImmediate(() => {
        pty.emit("sess-1", "task_complete", {
          response: "codex finished refactor",
        });
        pty.emit("sess-1", "stopped", { response: "codex finished refactor" });
      });
      return {
        success: true,
        text: "",
        data: {
          agents: [
            {
              sessionId: "sess-1",
              agentType: "codex",
              workdir: "/workspace/tasks/x",
              label: "scratch/refactor",
              status: "ready",
            },
          ],
        },
      };
    });
    const runtime = buildRuntime({
      action: { handler: actionHandler },
      pty,
    });

    const res = await handler(
      { task: "refactor parser", timeout_ms: 5000 },
      runtime,
      fakeMessage(),
    );

    expect(res.is_error).toBe(false);
    expect(res.content).toContain("codex finished refactor");
    expect(res.content).toContain("sessions: sess-1");
    expect(actionHandler).toHaveBeenCalledTimes(1);
    const callArgs = actionHandler.mock.calls[0];
    const synthMsg = callArgs[1] as Memory;
    const opts = callArgs[3] as { parameters?: Record<string, unknown> };
    expect((synthMsg.content as Record<string, unknown>).agentType).toBe(
      "codex",
    );
    expect(opts.parameters?.agentType).toBe("codex");
    expect(opts.parameters?.task).toBe("refactor parser");
  });

  it("flags downgrade when orchestrator routes to a non-codex framework", async () => {
    const runtime = buildRuntime({
      action: {
        handler: async () => {
          setImmediate(() => {
            pty.emit("sess-2", "task_complete", { response: "claude did it" });
            pty.emit("sess-2", "stopped", {});
          });
          return {
            success: true,
            data: {
              agents: [
                { sessionId: "sess-2", agentType: "claude", status: "ready" },
              ],
            },
          };
        },
      },
      pty,
    });
    const res = await handler(
      { task: "anything", timeout_ms: 5000 },
      runtime,
      fakeMessage(),
    );
    expect(res.is_error).toBe(false);
    expect(res.content).toMatch(/routed this task to 'claude'/);
  });
});

describe("spawn_codex failure paths", () => {
  it("returns is_error when CREATE_TASK reports success=false", async () => {
    const runtime = buildRuntime({
      action: {
        handler: async (_rt, _msg, _s, _o, cb) => {
          await cb?.({ text: "Workspace Service is not available." } as never);
          return {
            success: false,
            error: "WORKSPACE_SERVICE_UNAVAILABLE",
            text: "Workspace Service is not available.",
          };
        },
      },
    });
    const res = await handler({ task: "go" }, runtime, fakeMessage());
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/CREATE_TASK failed/);
    expect(res.content).toMatch(/Workspace Service is not available/);
  });

  it("returns is_error when CREATE_TASK throws", async () => {
    const runtime = buildRuntime({
      action: {
        handler: async () => {
          throw new Error("boom");
        },
      },
    });
    const res = await handler({ task: "go" }, runtime, fakeMessage());
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/CREATE_TASK threw: boom/);
  });

  it("returns is_error when CREATE_TASK succeeds but yields no session ids", async () => {
    const runtime = buildRuntime({
      action: {
        handler: async () => ({ success: true, data: { agents: [] } }),
      },
    });
    const res = await handler({ task: "go" }, runtime, fakeMessage());
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/no session ids/);
  });

  it("times out without throwing if no terminal events arrive", async () => {
    const pty = makePty();
    const runtime = buildRuntime({
      action: {
        handler: async () => ({
          success: true,
          data: {
            agents: [{ sessionId: "sess-stuck", agentType: "codex" }],
          },
        }),
      },
      pty,
    });
    const res = await handler(
      { task: "stuck", timeout_ms: 50 },
      runtime,
      fakeMessage(),
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/timed out after 50ms/);
    expect(res.content).toMatch(/sess-stuck/);
  });

  it("captures error events as failure reasons", async () => {
    const pty = makePty();
    const runtime = buildRuntime({
      action: {
        handler: async () => {
          setImmediate(() => {
            pty.emit("sess-err", "error", { message: "auth failed" });
          });
          return {
            success: true,
            data: {
              agents: [{ sessionId: "sess-err", agentType: "codex" }],
            },
          };
        },
      },
      pty,
    });
    const res = await handler(
      { task: "fail", timeout_ms: 5000 },
      runtime,
      fakeMessage(),
    );
    expect(res.is_error).toBe(true);
    expect(res.content).toMatch(/subagent failed/);
    expect(res.content).toMatch(/auth failed/);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
