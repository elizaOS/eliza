/**
 * Verifies TASKS:spawn_agent.
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";
// SPAWN_AGENT is `TASKS { action: "spawn_agent" }`.
import { spawnAgentAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const spawnOptions = { parameters: { action: "spawn_agent" } };
const TASK_ROOM = "11111111-2222-3333-4444-555555555555";
const WORKTREE_ROOM = "22222222-3333-4444-5555-666666666666";

describe("TASKS:spawn_agent", () => {
  it("does not expose lockWorkdir to planner-generated tool calls", () => {
    expect(
      spawnAgentAction.parameters?.map((param) => param.name),
    ).not.toContain("lockWorkdir");
  });

  it("does not expose keepAliveAfterComplete to planner-generated tool calls", () => {
    expect(
      spawnAgentAction.parameters?.map((param) => param.name),
    ).not.toContain("keepAliveAfterComplete");
  });

  it("validates with explicit payload and a service available", async () => {
    expect(
      await spawnAgentAction.validate(
        runtimeWith(serviceMock()),
        memory({ task: "fix bug" }),
        state,
      ),
    ).toBe(true);
    expect(
      await spawnAgentAction.validate(
        runtimeWith(undefined),
        memory({ task: "fix bug" }),
        state,
      ),
    ).toBe(false);
  });

  it("keeps TASKS available for routed sub-agent terminal events", async () => {
    expect(
      await spawnAgentAction.validate(
        runtimeWith(serviceMock()),
        memory({
          source: "sub_agent",
          metadata: {
            subAgent: true,
            subAgentEvent: "task_complete",
            subAgentSessionId: "abcdef123456",
          },
        }),
        state,
      ),
    ).toBe(true);
    expect(
      await spawnAgentAction.validate(
        runtimeWith(serviceMock()),
        memory({ source: "sub_agent" }),
        state,
      ),
    ).toBe(false);
  });

  it("spawns a session with compatible data shape", async () => {
    const svc = serviceMock();
    const cb = callback();
    const workdir = process.cwd();
    const result = await spawnAgentAction.handler(
      runtimeWith(svc),
      memory({ task: "fix bug", agentType: "codex", workdir }),
      state,
      spawnOptions,
      cb,
    );
    expect(result?.success).toBe(true);
    expect(result?.text).toBe("");
    expect(cb).not.toHaveBeenCalled();
    expect(result?.continueChain).toBe(false);
    expect(result?.data).toMatchObject({
      sessionId: "abcdef123456",
      agentType: "codex",
      workdir,
      status: "ready",
    });
  });

  it("carries the connector message id for platform-threaded final replies", async () => {
    const svc = serviceMock();
    await spawnAgentAction.handler(
      runtimeWith(svc),
      {
        ...memory({ task: "fix bug", agentType: "codex" }),
        metadata: {
          messageIdFull: "1506941896755249255",
          discord: { messageId: "1506941896755249255" },
        },
      } as never,
      state,
      spawnOptions,
      callback(),
    );

    const call = svc.spawnSession.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(call.metadata?.originConnectorMessageId).toBe("1506941896755249255");
  });

  it("persists custom verification and retry policy on the ACP session", async () => {
    const svc = serviceMock();
    const workdir = process.cwd();
    const validator = {
      service: "app-verification",
      method: "verifyPlugin",
      params: { workdir, pluginName: "proof-view", profile: "full" },
    };
    await spawnAgentAction.handler(
      runtimeWith(svc),
      memory({ task: "build a plugin view", agentType: "codex" }),
      state,
      {
        parameters: {
          action: "spawn_agent",
          workdir,
          lockWorkdir: true,
          validator,
          maxRetries: 2,
          onVerificationFail: "retry",
        },
      },
      callback(),
    );

    const call = svc.spawnSession.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(call.metadata).toMatchObject({
      validator,
      maxRetries: 2,
      onVerificationFail: "retry",
      keepAliveAfterComplete: true,
    });
  });

  it("ignores a standalone keep-alive request without a validator owner", async () => {
    const svc = serviceMock();
    await spawnAgentAction.handler(
      runtimeWith(svc),
      memory({ task: "build a script", agentType: "codex" }),
      state,
      {
        parameters: {
          action: "spawn_agent",
          keepAliveAfterComplete: true,
        },
      },
      callback(),
    );

    const call = svc.spawnSession.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(call.metadata?.keepAliveAfterComplete).toBe(false);
  });

  it("stamps deterministic deduped task/worktree swarm room metadata", async () => {
    const svc = serviceMock();
    const result = await spawnAgentAction.handler(
      runtimeWith(svc),
      memory({
        task: "coordinate the swarm",
        agentType: "codex",
        taskRoomId: TASK_ROOM,
        worktreeRoomId: WORKTREE_ROOM,
      }),
      state,
      spawnOptions,
      callback(),
    );

    expect(result?.success).toBe(true);
    const call = svc.spawnSession.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(call.metadata).toMatchObject({
      roomId: TASK_ROOM,
      originRoomId: "room1",
      taskRoomId: TASK_ROOM,
      worktreeRoomId: WORKTREE_ROOM,
      swarmRooms: [
        { roomId: TASK_ROOM, roles: ["task"] },
        { roomId: WORKTREE_ROOM, roles: ["worktree"] },
      ],
    });
  });

  it("injects focused coding and swarm coordination instructions", async () => {
    const svc = serviceMock();
    await spawnAgentAction.handler(
      runtimeWith(svc),
      memory({
        task: "fix the failing tests",
        agentType: "elizaos",
        taskRoomId: TASK_ROOM,
        worktreeRoomId: WORKTREE_ROOM,
      }),
      state,
      spawnOptions,
      callback(),
    );

    const call = svc.spawnSession.mock.calls[0]?.[0] as {
      initialTask?: string;
    };
    const initialTask = call.initialTask ?? "";
    expect(initialTask).toContain("--- Swarm Coordination ---");
    expect(initialTask).toContain("Keep working until the task is finished");
    expect(initialTask).toContain("read/search files, edit/apply patches");
    expect(initialTask).toContain("QUESTION_FOR_TASK_CREATOR");
    expect(initialTask).toContain("AGENT_COORDINATION");
    expect(initialTask).toContain(TASK_ROOM);
    expect(initialTask).toContain(WORKTREE_ROOM);
    // Regression for elizaOS/eliza#7935: sub-agents must not write
    // routing-kind constants as markdown banners in user-visible prose.
    // The router classifies routing from the session event; prose should
    // stay as the actual question or coordination note.
    expect(initialTask).toContain(
      "Do not prefix the reply with routing-kind labels",
    );
    expect(initialTask).toContain("no markdown banners");
    expect(initialTask).toContain(
      "the orchestrator classifies routing from the session event, not your prose",
    );
  });

  it("keeps both swarm roles when task room and worktree room are the same", async () => {
    const svc = serviceMock();
    await spawnAgentAction.handler(
      runtimeWith(svc),
      memory({
        task: "coordinate in one room",
        agentType: "codex",
        taskRoomId: TASK_ROOM,
        worktreeRoomId: TASK_ROOM,
      }),
      state,
      spawnOptions,
      callback(),
    );

    const call = svc.spawnSession.mock.calls[0]?.[0] as {
      metadata?: Record<string, unknown>;
    };
    expect(call.metadata?.swarmRooms).toEqual([
      { roomId: TASK_ROOM, roles: ["task", "worktree"] },
    ]);
  });

  it("does NOT defer from task text alone — deferral is structural, not regex", async () => {
    // The planner emits the structured `deferUserReply` flag when the user asks
    // for no interim reply; the orchestrator no longer regex-scans the task text
    // for "reply only after …" phrasings (that was message-text inspection,
    // which the project bans). The next test covers the structural path.
    const svc = serviceMock();
    const cb = callback();
    const result = await spawnAgentAction.handler(
      runtimeWith(svc),
      memory({
        task: "Build the app and verify the public URL. Reply only after verification with the final URL.",
        agentType: "opencode",
      }),
      state,
      spawnOptions,
      cb,
    );

    expect(result?.success).toBe(true);
    // No structured flag → not deferred, even though the text says "reply only after".
    expect(result?.data).not.toMatchObject({ deferredUserReply: true });
  });

  it("honors explicit deferUserReply from planner parameters", async () => {
    const svc = serviceMock();
    const cb = callback();
    const result = await spawnAgentAction.handler(
      runtimeWith(svc),
      memory({ task: "Build the app", agentType: "opencode" }),
      state,
      { parameters: { action: "spawn_agent", deferUserReply: true } },
      cb,
    );

    expect(result?.success).toBe(true);
    expect(result?.text).toBe("");
    expect(result?.data).toMatchObject({ deferredUserReply: true });
    expect(cb).not.toHaveBeenCalled();
  });

  it("puts resolved route constraints before planner-authored task text", async () => {
    const oldRoutes = process.env.TASK_AGENT_WORKDIR_ROUTES;
    process.env.TASK_AGENT_WORKDIR_ROUTES = JSON.stringify([
      {
        id: "local-apps",
        workdir: process.cwd(),
        matchAny: ["counter"],
        instructions: "Create app files under data/apps/<slug>/.",
        urlMappings: [
          {
            urlPrefix: "https://example.test/apps/",
            localPath: "data/apps/",
          },
        ],
      },
    ]);
    try {
      const svc = serviceMock();
      const result = await spawnAgentAction.handler(
        runtimeWith(svc),
        memory({
          task: "Create a counter at /srv/apps/opencode-check.",
          agentType: "opencode",
        }),
        state,
        spawnOptions,
        callback(),
      );
      expect(result?.success).toBe(true);
      const call = svc.spawnSession.mock.calls[0]?.[0] as {
        initialTask?: string;
        workdir?: string;
      };
      expect(call.workdir).toBe(process.cwd());
      const initialTask = call.initialTask ?? "";
      expect(initialTask).toContain("--- Resolved Workspace ---");
      expect(initialTask).toContain(`workdir: ${process.cwd()}`);
      expect(initialTask).toContain("absolute path outside this workdir");
      expect(initialTask).toContain(
        "Create app files under data/apps/<slug>/.",
      );
      expect(initialTask).toContain("--- URL Path Mapping ---");
      expect(initialTask).toContain(
        "URL prefix https://example.test/apps/ maps to local path data/apps/ under the resolved workdir",
      );
      expect(initialTask).toContain(
        "write files under data/apps/<slug>/, not apps/<slug>/ or public/apps/<slug>/",
      );
      expect(initialTask).toContain(
        "do not leave synthetic external assets, pending-work comments, or partial sample code",
      );
      expect(initialTask).toContain('do not leave inert href="#" controls');
      expect(initialTask.indexOf("--- Resolved Workspace ---")).toBeLessThan(
        initialTask.indexOf("--- User Task ---"),
      );
    } finally {
      if (oldRoutes === undefined) delete process.env.TASK_AGENT_WORKDIR_ROUTES;
      else process.env.TASK_AGENT_WORKDIR_ROUTES = oldRoutes;
    }
  });

  it("keeps an inherited workdir route for routed sub-agent follow-up turns", async () => {
    const oldRoutes = process.env.TASK_AGENT_WORKDIR_ROUTES;
    delete process.env.TASK_AGENT_WORKDIR_ROUTES;
    try {
      const svc = serviceMock();
      const result = await spawnAgentAction.handler(
        runtimeWith(svc),
        memory({
          source: "sub_agent",
          metadata: {
            subAgent: true,
            workdirRoute: {
              id: "local-apps",
              workdir: process.cwd(),
              instructions: "Write under data/apps/<slug>/.",
              urlMappings: [
                {
                  urlPrefix: "https://example.test/apps/",
                  localPath: "data/apps/",
                },
              ],
            },
          },
        }),
        state,
        {
          parameters: {
            action: "spawn_agent",
            task: "Continue the failed static page build.",
            agentType: "opencode",
          },
        },
        callback(),
      );
      expect(result?.success).toBe(true);
      const call = svc.spawnSession.mock.calls[0]?.[0] as {
        initialTask?: string;
        metadata?: Record<string, unknown>;
        workdir?: string;
      };
      expect(call.workdir).toBe(process.cwd());
      expect(call.metadata?.workdirRouteId).toBe("local-apps");
      expect(call.initialTask).toContain("--- URL Path Mapping ---");
      expect(call.initialTask).toContain("data/apps/<slug>/");
    } finally {
      if (oldRoutes === undefined) delete process.env.TASK_AGENT_WORKDIR_ROUTES;
      else process.env.TASK_AGENT_WORKDIR_ROUTES = oldRoutes;
    }
  });

  it("handles missing service and auth failures", async () => {
    const cb = callback();
    expect(
      (
        await spawnAgentAction.handler(
          runtimeWith(undefined),
          memory(),
          state,
          spawnOptions,
          cb,
        )
      )?.error,
    ).toBe("SERVICE_UNAVAILABLE");
    const svc = serviceMock({
      spawnSession: vi.fn(async () => {
        throw new Error("login required");
      }),
    });
    expect(
      (
        await spawnAgentAction.handler(
          runtimeWith(svc),
          memory({ task: "x" }),
          state,
          spawnOptions,
          callback(),
        )
      )?.error,
    ).toBe("INVALID_CREDENTIALS");
  });
});
