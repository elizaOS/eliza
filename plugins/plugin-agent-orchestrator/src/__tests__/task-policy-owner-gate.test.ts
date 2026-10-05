/** Validates connector role gates with deterministic runtime and message fixtures. */

import type { AgentRuntime, Memory } from "@elizaos/core";
import { stringToUuid } from "@elizaos/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { requireTaskAgentAccess } from "../services/task-policy.js";
import { createRealTestRuntime } from "./real-runtime.js";

let runtime: AgentRuntime;
let cleanupRuntime: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ({ runtime, cleanup: cleanupRuntime } = await createRealTestRuntime({
    characterName: "TaskPolicyOwnerGateTest",
  }));
}, 60_000);

afterEach(() => {
  vi.restoreAllMocks();
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
  it.each([" OWNER ", { create: " OWNER ", interact: " OWNER " }])(
    "preserves normalized operator policy at the configuration boundary: %j",
    async (policy) => {
      runtime.character.settings = {
        ...runtime.character.settings,
        TASK_AGENT_ROLE_POLICY: JSON.stringify({
          connectors: { discord: policy },
        }),
      };
      for (const ability of ["create", "interact"] as const) {
        const access = await requireTaskAgentAccess(
          runtime,
          message(),
          ability,
        );
        expect(access.requiredRole).toBe("OWNER");
        expect(access.allowed).toBe(false);
      }
    },
  );

  it("denies access and reports failed role storage reads", async () => {
    const error = new Error("role storage unavailable");
    vi.spyOn(runtime, "getRoom").mockRejectedValueOnce(error);
    const report = vi
      .spyOn(runtime, "reportError")
      .mockImplementation(() => {});

    const access = await requireTaskAgentAccess(runtime, message(), "create");

    expect(access.allowed).toBe(false);
    expect(report).toHaveBeenCalledWith(
      "task-policy.resolveSenderRole",
      error,
      {
        roomId: message().roomId,
      },
    );
  });

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
