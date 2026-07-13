/** Validates connector role gates with deterministic runtime and message fixtures. */

import type { AgentRuntime, Memory } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { requireTaskAgentAccess } from "../services/task-policy.js";
import { createRealTestRuntime } from "./real-runtime.js";

let runtime: AgentRuntime;
let cleanupRuntime: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ runtime, cleanup: cleanupRuntime } = await createRealTestRuntime({
    characterName: "TaskPolicyOwnerGateTest",
  }));
});

afterEach(() => {
  if (runtime.character.settings) {
    delete runtime.character.settings.TASK_AGENT_ROLE_POLICY;
  }
});

afterAll(async () => {
  await cleanupRuntime?.();
});

function message(): Memory {
  return {
    id: stringToUuid("msg"),
    entityId: stringToUuid("human"),
    roomId: stringToUuid("room"),
    content: { text: "spawn a coding agent", source: "discord" },
  };
}

describe("task-agent role policy", () => {
  it("defaults Discord task-agent create/interact to OWNER-only", async () => {
    const access = await requireTaskAgentAccess(runtime, message(), "create");

    expect(access.allowed).toBe(false);
    expect(access.connector).toBe("discord");
    expect(access.requiredRole).toBe("OWNER");
  });

  it("keeps explicit operator policy overrides available", async () => {
    runtime.character.settings = {
      ...runtime.character.settings,
      TASK_AGENT_ROLE_POLICY: JSON.stringify({
        connectors: { discord: { create: "ADMIN" } },
      }),
    };
    const access = await requireTaskAgentAccess(runtime, message(), "create");

    expect(access.allowed).toBe(false);
    expect(access.requiredRole).toBe("ADMIN");
  });
});
