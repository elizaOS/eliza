import type { IAgentRuntime, Memory } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { requireTaskAgentAccess } from "../services/task-policy.js";

function runtime(settings: Record<string, unknown> = {}): IAgentRuntime {
  return {
    agentId: stringToUuid("agent"),
    getSetting: (key: string) => settings[key],
    getRoom: vi.fn(async () => ({ source: "discord" })),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

function message(): Memory {
  return {
    id: stringToUuid("msg"),
    entityId: stringToUuid("human"),
    roomId: stringToUuid("room"),
    content: { text: "spawn a coding agent" },
  } as unknown as Memory;
}

describe("task-agent role policy", () => {
  it("defaults Discord task-agent create/interact to OWNER-only", async () => {
    const access = await requireTaskAgentAccess(runtime(), message(), "create");

    expect(access.allowed).toBe(false);
    expect(access.connector).toBe("discord");
    expect(access.requiredRole).toBe("OWNER");
  });

  it("keeps explicit operator policy overrides available", async () => {
    const access = await requireTaskAgentAccess(
      runtime({
        TASK_AGENT_ROLE_POLICY: JSON.stringify({
          connectors: { discord: { create: "ADMIN" } },
        }),
      }),
      message(),
      "create",
    );

    expect(access.allowed).toBe(false);
    expect(access.requiredRole).toBe("ADMIN");
  });
});
