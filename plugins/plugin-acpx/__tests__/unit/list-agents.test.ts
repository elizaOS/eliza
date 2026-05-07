import { describe, expect, it } from "vitest";
import { listAgentsAction } from "../../src/actions/list-agents.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

describe("LIST_AGENTS", () => {
  it("validates service presence", async () => {
    expect(
      await listAgentsAction.validate(
        runtimeWith(serviceMock()),
        memory(),
        state,
      ),
    ).toBe(true);
    expect(
      await listAgentsAction.validate(runtimeWith(undefined), memory(), state),
    ).toBe(false);
  });
  it("lists sessions with exact public fields", async () => {
    const result = await listAgentsAction.handler(
      runtimeWith(serviceMock()),
      memory(),
      state,
      {},
      callback(),
    );
    expect(result?.success).toBe(true);
    expect(result?.data?.sessions).toEqual([
      {
        id: "abcdef123456",
        agentType: "codex",
        status: "ready",
        workdir: "/tmp/acp",
        createdAt: "2026-05-03T10:00:00.000Z",
        lastActivity: "2026-05-03T10:00:00.000Z",
        label: "demo",
      },
    ]);
  });
  it("handles missing service", async () => {
    expect(
      (
        await listAgentsAction.handler(
          runtimeWith(undefined),
          memory(),
          state,
          {},
          callback(),
        )
      )?.error,
    ).toBe("SERVICE_UNAVAILABLE");
  });
});
