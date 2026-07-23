/**
 * Verifies TASKS:list_agents.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it, vi } from "vitest";
// LIST_AGENTS is `TASKS { action: "list_agents" }`.
import { listAgentsAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

const listOptions = { parameters: { action: "list_agents" } };

describe("TASKS:list_agents", () => {
  it("keeps list_agents planner-visible on the umbrella action", () => {
    expect(
      listAgentsAction.parameters?.find(
        (parameter) => parameter.name === "action",
      )?.schema.enum,
    ).toContain("list_agents");
  });

  it("lists sessions with exact public fields", async () => {
    const listCallback = callback();
    const result = await listAgentsAction.handler(
      runtimeWith(serviceMock()),
      memory(),
      state,
      listOptions,
      listCallback,
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
    expect(listCallback).not.toHaveBeenCalled();
  });

  it("returns the designed empty result without posting a raw callback", async () => {
    const listCallback = callback();
    const result = await listAgentsAction.handler(
      runtimeWith(serviceMock({ listSessions: vi.fn(() => []) })),
      memory(),
      state,
      listOptions,
      listCallback,
    );

    expect(result).toMatchObject({
      success: true,
      data: { sessions: [] },
    });
    expect(result?.text).toContain("No active task agents");
    expect(listCallback).not.toHaveBeenCalled();
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
