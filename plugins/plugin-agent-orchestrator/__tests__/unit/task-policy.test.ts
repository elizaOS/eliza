/**
 * A partial TASK_AGENT_ROLE_POLICY override (e.g. only tightening slack) must
 * MERGE over the built-in defaults, not replace them — otherwise the built-in
 * Discord ADMIN gate is silently dropped and Discord falls through to the GUEST
 * default, opening task-agent create/interact to anyone.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { requireTaskAgentAccess } from "../../src/services/task-policy.js";

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

// resolveSenderRole dynamically imports @elizaos/core on first use; that cold
// import transforms the whole core package under vitest and can exceed the 5s
// default timeout (it crossed it when core gained the generated pricing/context
// tables). The timeout covers the one-time import, not the logic under test.
const COLD_CORE_IMPORT_TIMEOUT_MS = 30_000;

describe("requireTaskAgentAccess — policy merge", () => {
  it(
    "keeps the built-in Discord OWNER gate when only another connector is overridden",
    async () => {
      const result = await requireTaskAgentAccess(
        runtimeWith({ connectors: { slack: "ADMIN" } }),
        discordMessage,
        "create",
      );
      expect(result.requiredRole).toBe("OWNER");
    },
    COLD_CORE_IMPORT_TIMEOUT_MS,
  );

  it(
    "still requires Discord OWNER under the default policy (no override)",
    async () => {
      const result = await requireTaskAgentAccess(
        runtimeWith(undefined),
        discordMessage,
        "interact",
      );
      expect(result.requiredRole).toBe("OWNER");
    },
    COLD_CORE_IMPORT_TIMEOUT_MS,
  );
});
