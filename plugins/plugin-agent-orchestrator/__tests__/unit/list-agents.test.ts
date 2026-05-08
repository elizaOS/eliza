import { describe, expect, it } from "vitest";
// Post-consolidation: LIST_AGENTS is `TASKS { op: "list_agents" }`.
import { listAgentsAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const listOptions = { parameters: { op: "list_agents" } };

describe("TASKS:list_agents (legacy LIST_AGENTS)", () => {
  it("lists sessions with exact public fields", async () => {
    const result = await listAgentsAction.handler(
      runtimeWith(serviceMock()),
      memory(),
      state,
      listOptions,
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
  it("reports SERVICE_UNAVAILABLE when ACP is missing", async () => {
    expect(
      (
        await listAgentsAction.handler(
          runtimeWith(undefined),
          memory(),
          state,
          listOptions,
          callback(),
        )
      )?.error,
    ).toBe("SERVICE_UNAVAILABLE");
  });
});
