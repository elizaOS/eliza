/**
 * Fail-closed error-path coverage for hasPrivateAccess (#12265). A throw from
 * the core private-access check is a broken role/world-resolution pipeline (a
 * missing world returns null upstream, not a throw). The handler must stay
 * fail-closed (deny) AND surface the failure via runtime.reportError so a
 * silently-denying broken check becomes observable. The tests drive the real
 * agent access wrapper and core role primitives with minimal typed runtime
 * collaborators.
 */

import type { IAgentRuntime, Memory, Room, UUID, World } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { hasPrivateAccess } from "./access.ts";

const AGENT_ID = "00000000-0000-0000-0000-0000000000bb" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-0000000000dd" as UUID;

function runtimeWith(
  reportError: () => void,
  overrides: Partial<IAgentRuntime> = {},
): IAgentRuntime {
  return {
    agentId: AGENT_ID,
    getSetting: () => undefined,
    reportError,
    ...overrides,
  } as unknown as IAgentRuntime;
}

function message(): Memory {
  return {
    id: "00000000-0000-0000-0000-0000000000cc" as UUID,
    entityId: ENTITY_ID,
    roomId: "00000000-0000-0000-0000-0000000000aa" as UUID,
    content: { text: "x" },
  } as Memory;
}

describe("hasPrivateAccess fail-closed reporting (#12265)", () => {
  it("denies AND reports when the core private-access check throws", async () => {
    const roleError = new Error("role resolution failed");
    const reportError = vi.fn();

    const granted = await hasPrivateAccess(
      runtimeWith(reportError, {
        getRoom: async () => {
          throw roleError;
        },
      }),
      message(),
    );

    // Fail closed: a broken check must never grant access.
    expect(granted).toBe(false);
    // But the broken pipeline is surfaced, not silently swallowed.
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0]?.[0]).toBe("Access.hasPrivateAccess");
    expect(reportError.mock.calls[0]?.[1]).toBeInstanceOf(Error);
  });

  it("grants without reporting when the check succeeds", async () => {
    const reportError = vi.fn();
    const worldId = "00000000-0000-0000-0000-0000000000ee" as UUID;
    const privateRoom: Room = {
      id: message().roomId,
      agentId: AGENT_ID,
      source: "test",
      type: "DM",
      worldId,
    };
    const privateWorld: World = {
      id: worldId,
      agentId: AGENT_ID,
      name: "private",
      metadata: {
        roles: { [ENTITY_ID]: "MEMBER" },
      },
    };

    const granted = await hasPrivateAccess(
      runtimeWith(reportError, {
        getRoom: async () => privateRoom,
        getWorld: async () => privateWorld,
      }),
      message(),
    );

    expect(granted).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
  });
});
