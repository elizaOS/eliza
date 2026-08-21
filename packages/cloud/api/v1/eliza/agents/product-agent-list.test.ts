/** Deterministic contract for server-authoritative Shared-to-Dedicated list cutover. */

import { describe, expect, test } from "bun:test";
import { projectProductAgentList } from "./product-agent-list";

const shared = {
  id: "shared-1",
  execution_tier: "shared",
  agent_config: null,
};

function dedicated(agentConfig: Record<string, unknown>) {
  return {
    id: "dedicated-1",
    execution_tier: "dedicated-always",
    agent_config: agentConfig,
  };
}

describe("projectProductAgentList", () => {
  test("keeps Shared visible while a Dedicated target is only pending", () => {
    expect(
      projectProductAgentList([
        shared,
        dedicated({ __agentUpgradedFrom: shared.id }),
      ]).map((agent) => agent.id),
    ).toEqual(["shared-1", "dedicated-1"]);
  });

  test("retires Shared only after the exact completed cutover receipt", () => {
    expect(
      projectProductAgentList([
        shared,
        dedicated({
          __agentUpgradedFrom: shared.id,
          __agentPersonalCutover: {
            mode: "dedicated",
            sourceAgentId: shared.id,
            conversationId: shared.id,
            cutoverToken: "cutover-token",
            sharedMessageCount: 2,
            sharedScheduledTaskCount: 1,
            sharedTodoCount: 1,
            sharedTodoMutationCount: 1,
            sharedTodoDigest: "a".repeat(64),
            activatedAt: "2026-08-19T12:00:00.000Z",
          },
        }),
      ]).map((agent) => agent.id),
    ).toEqual(["dedicated-1"]);
  });

  test("fails visible when a cutover marker is malformed or names another source", () => {
    const malformed = dedicated({
      __agentPersonalCutover: {
        mode: "dedicated",
        sourceAgentId: shared.id,
        conversationId: shared.id,
        cutoverToken: "cutover-token",
        sharedMessageCount: -1,
        activatedAt: "2026-08-19T12:00:00.000Z",
      },
    });
    const other = {
      ...dedicated({
        __agentPersonalCutover: {
          mode: "dedicated",
          sourceAgentId: "shared-other",
          conversationId: "shared-other",
          cutoverToken: "cutover-token",
          sharedMessageCount: 0,
          sharedScheduledTaskCount: 0,
          sharedTodoCount: 0,
          sharedTodoMutationCount: 0,
          sharedTodoDigest: "b".repeat(64),
          activatedAt: "2026-08-19T12:00:00.000Z",
        },
      }),
      id: "dedicated-2",
    };

    expect(
      projectProductAgentList([shared, malformed, other]).map(({ id }) => id),
    ).toEqual(["shared-1", "dedicated-1", "dedicated-2"]);
  });
});
