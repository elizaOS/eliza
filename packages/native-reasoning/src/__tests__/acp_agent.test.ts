import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  createTaskHandler,
  sessionsSpawnHandler,
  spawnAgentHandler,
} from "../tools/acp_agent.js";

function makeRuntime() {
  const sessions = new Map<string, Record<string, unknown>>();
  const events: Array<(sid: string, event: string, data: unknown) => void> = [];
  const store = {
    get: vi.fn(async (id: string) => sessions.get(id) ?? null),
    update: vi.fn(async (id: string, patch: Record<string, unknown>) => {
      const current = sessions.get(id) ?? {};
      sessions.set(id, { ...current, ...patch });
    }),
  };
  const service = {
    store,
    spawnSession: vi.fn(async (opts: Record<string, unknown>) => {
      const session = {
        id: "session-1",
        sessionId: "session-1",
        name: opts.name,
        agentType: opts.agentType,
        workdir: opts.workdir,
        status: "ready",
        metadata: opts.metadata,
      };
      sessions.set("session-1", session);
      return session;
    }),
    sendPrompt: vi.fn(async (sessionId: string) => {
      for (const cb of events) {
        cb(sessionId, "task_complete", {
          response: "subagent receipt output",
          stopReason: "end_turn",
        });
      }
      return {
        response: "subagent receipt output",
        finalText: "subagent receipt output",
        stopReason: "end_turn",
        durationMs: 42,
      };
    }),
    closeSession: vi.fn(async (sessionId: string) => {
      for (const cb of events) {
        cb(sessionId, "stopped", {
          sessionId,
          response: "subagent receipt output",
        });
      }
    }),
    onSessionEvent: vi.fn((cb) => {
      events.push(cb);
      return () => {
        const index = events.indexOf(cb);
        if (index >= 0) events.splice(index, 1);
      };
    }),
  };
  const runtime = {
    getService: vi.fn((name: string) =>
      name === "ACP_SUBPROCESS_SERVICE" ? service : undefined,
    ),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
  const message = {
    id: "message-1",
    roomId: "room-1",
    worldId: "world-1",
    entityId: "user-1",
    content: { source: "discord" },
  } as unknown as Memory;
  return { runtime, message, service, store, sessions };
}

describe("native ACP agent tools", () => {
  it("spawn_agent writes an acpx receipt with output and stopped terminal state", async () => {
    const { runtime, message, service, store, sessions } = makeRuntime();
    const result = await spawnAgentHandler(
      { prompt: "do multi-step work", cwd: "/workspace/tasks/test-receipt" },
      runtime,
      message,
    );

    expect(result.is_error).toBeFalsy();
    expect(service.closeSession).toHaveBeenCalledWith("session-1");
    expect(store.update).toHaveBeenCalled();
    const record = sessions.get("session-1");
    expect(record?.status).toBe("stopped");
    expect(record?.workdir).toBe("/workspace/tasks/test-receipt");
    const metadata = record?.metadata as Record<string, unknown>;
    expect(metadata.source).toBe("acpx");
    expect(metadata.origin).toBe("acpx");
    expect(metadata.output).toBe("subagent receipt output");
    expect(metadata.actionHandlerTrace).toContain("spawn_agent");
    expect(metadata.terminalState).toMatchObject({
      status: "stopped",
      stopReason: "end_turn",
      durationMs: 42,
      persistent: false,
    });
  });

  it("sessions_spawn leaves a persistent ready receipt and create_task is an alias", async () => {
    const first = makeRuntime();
    const spawned = await sessionsSpawnHandler(
      { initial_prompt: "continue later", name: "keep-me" },
      first.runtime,
      first.message,
    );
    expect(spawned.is_error).toBeFalsy();
    expect(first.service.closeSession).not.toHaveBeenCalled();
    const metadata = first.sessions.get("session-1")?.metadata as Record<
      string,
      unknown
    >;
    expect(first.sessions.get("session-1")?.status).toBe("ready");
    expect(metadata.source).toBe("acpx");
    expect(metadata.terminalState).toMatchObject({
      status: "ready",
      persistent: true,
    });

    const second = makeRuntime();
    const aliased = await createTaskHandler(
      { initial_prompt: "compat task" },
      second.runtime,
      second.message,
    );
    expect(aliased.is_error).toBeFalsy();
    expect(aliased.content).toContain('"tool": "create_task"');
  });
});
