import { describe, expect, it, vi } from "vitest";
// Post-consolidation: SPAWN_AGENT is `TASKS { action: "spawn_agent" }`.
import { spawnAgentAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const spawnOptions = { parameters: { action: "spawn_agent" } };

describe("TASKS:spawn_agent", () => {
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
    // Spawn is fire-and-forget: the handler returns a brief ack so the
    // planner loop ships *something* to the user instead of silent success.
    expect(result?.text).toBe(
      "On it — spawning codex sub-agent to handle your request.",
    );
    expect(result?.data).toMatchObject({
      sessionId: "abcdef123456",
      agentType: "codex",
      workdir,
      status: "ready",
    });
  });

  it("suppresses the spawn acknowledgement when the user requested a deferred reply", async () => {
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
    expect(result?.text).toBe("");
    expect(result?.data).toMatchObject({ deferredUserReply: true });
    expect(cb).not.toHaveBeenCalled();
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
      expect(initialTask.indexOf("--- Resolved Workspace ---")).toBeLessThan(
        initialTask.indexOf("--- User Task ---"),
      );
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
