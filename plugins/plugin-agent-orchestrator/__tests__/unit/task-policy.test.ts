import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { requireTaskAgentAccess } from "../../src/services/task-policy.js";

/**
 * A partial TASK_AGENT_ROLE_POLICY override (e.g. only tightening slack) must
 * MERGE over the built-in defaults, not replace them — otherwise the built-in
 * Discord ADMIN gate is silently dropped and Discord falls through to the GUEST
 * default, opening task-agent create/interact to anyone.
 */
function runtimeWith(policy: unknown): IAgentRuntime {
  return {
    agentId: "00000000-0000-4000-8000-00000000pol1",
    getSetting: (k: string) =>
      k === "TASK_AGENT_ROLE_POLICY"
        ? typeof policy === "string"
          ? policy
          : JSON.stringify(policy)
        : undefined,
    getRoom: async () => undefined,
    getParticipantUserState: async () => null,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as never;
}

const discordMessage = {
  entityId: "user-x",
  roomId: "00000000-0000-4000-8000-00000000room",
  content: { source: "discord" },
} as unknown as Memory;

describe("requireTaskAgentAccess — policy merge", () => {
  it("keeps the built-in Discord ADMIN gate when only another connector is overridden", async () => {
    const result = await requireTaskAgentAccess(
      runtimeWith({ connectors: { slack: "ADMIN" } }),
      discordMessage,
      "create",
    );
    // Discord still requires ADMIN despite the slack-only override.
    expect(result.requiredRole).toBe("ADMIN");
  });

  it("still requires Discord ADMIN under the default policy (no override)", async () => {
    const result = await requireTaskAgentAccess(
      runtimeWith(undefined),
      discordMessage,
      "interact",
    );
    expect(result.requiredRole).toBe("ADMIN");
  });
});
