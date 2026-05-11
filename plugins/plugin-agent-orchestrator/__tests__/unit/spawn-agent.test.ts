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

  it("spawns a session with compatible data shape", async () => {
    const svc = serviceMock();
    const cb = callback();
    const result = await spawnAgentAction.handler(
      runtimeWith(svc),
      memory({ task: "fix bug", agentType: "codex", workdir: "/tmp/x" }),
      state,
      spawnOptions,
      cb,
    );
    expect(result?.success).toBe(true);
    expect(result?.text).toBe("");
    expect(result?.data).toMatchObject({
      sessionId: "abcdef123456",
      agentType: "codex",
      workdir: "/tmp/x",
      status: "ready",
    });
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
