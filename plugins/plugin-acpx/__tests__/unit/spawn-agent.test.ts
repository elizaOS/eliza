import { describe, expect, it, vi } from "vitest";
import { spawnAgentAction } from "../../src/actions/spawn-agent.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("SPAWN_AGENT", () => {
  it("describes broad task-agent work including media and file assets", () => {
    expect(spawnAgentAction.description).toContain("media/file asset work");
  });

  it("validates explicit payload and rejects missing service", async () => {
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
      {},
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

  it("handles missing service and failures", async () => {
    const cb = callback();
    expect(
      (
        await spawnAgentAction.handler(
          runtimeWith(undefined),
          memory(),
          state,
          {},
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
          {},
          callback(),
        )
      )?.error,
    ).toBe("INVALID_CREDENTIALS");
  });
});
