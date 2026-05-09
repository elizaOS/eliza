import { describe, expect, it, vi } from "vitest";
// Post-consolidation: CREATE_AGENT_TASK is `TASKS { op: "create" }` (default op).
import { createTaskAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("TASKS:create (legacy CREATE_AGENT_TASK)", () => {
  it("validates explicit payload and declines LifeOps", async () => {
    expect(
      await createTaskAction.validate(
        runtimeWith(serviceMock()),
        memory({ task: "implement feature" }),
        state,
      ),
    ).toBe(true);
    expect(
      await createTaskAction.validate(
        runtimeWith(serviceMock()),
        memory({ text: "add a todo to fix that PR" }),
        state,
      ),
    ).toBe(false);
  });
  it("supports nyx options.parameters and returns data.agents[].sessionId plus id", async () => {
    const svc = serviceMock();
    const result = await createTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      state,
      {
        parameters: {
          op: "create",
          task: "fix bug",
          agentType: "codex",
          workdir: "/tmp/nyx",
          model: "gpt-5.5",
          approvalPreset: "readonly",
          timeout_ms: 1000,
        },
      },
      callback(),
    );
    expect(result?.success).toBe(true);
    expect(result?.text).toBe("");
    expect(result?.data?.agents).toEqual([
      {
        id: "abcdef123456",
        sessionId: "abcdef123456",
        agentType: "codex",
        name: "agent-one",
        workdir: "/tmp/nyx",
        label: "fix bug",
        status: "completed",
      },
    ]);
    expect(svc.emitSessionEvent).toHaveBeenCalledWith(
      "abcdef123456",
      "task_complete",
      expect.objectContaining({ response: "done" }),
    );
  });
  it("handles missing service, auth error, generic failure", async () => {
    expect(
      (
        await createTaskAction.handler(
          runtimeWith(undefined),
          memory(),
          state,
          { parameters: { op: "create" } },
          callback(),
        )
      )?.error,
    ).toBe("SERVICE_UNAVAILABLE");
    const auth = serviceMock({
      spawnSession: vi.fn(async () => {
        throw new Error("auth failed");
      }),
    });
    const authResult = await createTaskAction.handler(
      runtimeWith(auth),
      memory({ task: "x" }),
      state,
      { parameters: { op: "create" } },
      callback(),
    );
    expect(authResult?.success).toBe(false);
    expect(authResult?.data?.agents).toBeDefined();
    const fail = serviceMock({
      sendPrompt: vi.fn(async () => ({
        sessionId: "abcdef123456",
        response: "",
        finalText: "",
        stopReason: "error",
        durationMs: 1,
        error: "boom",
      })),
    });
    expect(
      (
        await createTaskAction.handler(
          runtimeWith(fail),
          memory({ task: "x" }),
          state,
          { parameters: { op: "create" } },
          callback(),
        )
      )?.success,
    ).toBe(false);
  });
});
