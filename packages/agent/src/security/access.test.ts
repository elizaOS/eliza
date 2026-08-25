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
import {
  hasAdminAccess,
  hasOwnerAccess,
  hasPrivateAccess,
  isAgentSelf,
} from "./access.ts";

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

describe("isAgentSelf", () => {
  it("returns true when entityId equals agentId", () => {
    const runtime = { agentId: AGENT_ID } as unknown as IAgentRuntime;
    const msg = { entityId: AGENT_ID } as Memory;
    expect(isAgentSelf(runtime, msg)).toBe(true);
  });

  it("returns false when entityId differs from agentId", () => {
    const runtime = { agentId: AGENT_ID } as unknown as IAgentRuntime;
    const msg = { entityId: ENTITY_ID } as Memory;
    expect(isAgentSelf(runtime, msg)).toBe(false);
  });

  it("returns false when runtime is undefined", () => {
    const msg = { entityId: AGENT_ID } as Memory;
    expect(isAgentSelf(undefined, msg)).toBe(false);
  });

  it("returns false when message is undefined", () => {
    const runtime = { agentId: AGENT_ID } as unknown as IAgentRuntime;
    expect(isAgentSelf(runtime, undefined)).toBe(false);
  });

  it("returns false when both are undefined", () => {
    expect(isAgentSelf(undefined, undefined)).toBe(false);
  });

  it("returns false when entityId is empty string", () => {
    const runtime = { agentId: AGENT_ID } as unknown as IAgentRuntime;
    const msg = { entityId: "" } as Memory;
    expect(isAgentSelf(runtime, msg)).toBe(false);
  });

  it("returns false when runtime has no agentId string", () => {
    const runtime = {} as unknown as IAgentRuntime;
    const msg = { entityId: AGENT_ID } as Memory;
    expect(isAgentSelf(runtime, msg)).toBe(false);
  });

  it("returns false when message has no entityId string", () => {
    const runtime = { agentId: AGENT_ID } as unknown as IAgentRuntime;
    const msg = {} as Memory;
    expect(isAgentSelf(runtime, msg)).toBe(false);
  });

  it("compares by strict equality, not type coercion", () => {
    const runtime = { agentId: "123" } as unknown as IAgentRuntime;
    const msg = { entityId: "123" as unknown as UUID } as Memory;
    expect(isAgentSelf(runtime, msg)).toBe(true);
    const msg2 = { entityId: "123 " as unknown as UUID } as Memory;
    expect(isAgentSelf(runtime, msg2)).toBe(false);
  });
});

describe("hasOwnerAccess delegates to core OWNER gate", () => {
  it("denies when runtime has no OWNER role", async () => {
    const granted = await hasOwnerAccess(
      runtimeWith(vi.fn(), {
        getRoom: async () => null,
        getWorld: async () => null,
        getSetting: () => undefined,
      } as unknown as Partial<IAgentRuntime>),
      message(),
    );
    expect(granted).toBe(false);
  });

  it("grants when entity is canonical owner via ELIZA_ADMIN_ENTITY_ID", async () => {
    const granted = await hasOwnerAccess(
      runtimeWith(vi.fn(), {
        getSetting: (key: string) =>
          key === "ELIZA_ADMIN_ENTITY_ID" ? ENTITY_ID : undefined,
      } as unknown as Partial<IAgentRuntime>),
      message(),
    );
    expect(granted).toBe(true);
  });
});

describe("hasAdminAccess delegates to core ADMIN gate", () => {
  it("denies when entity lacks ADMIN", async () => {
    const granted = await hasAdminAccess(
      runtimeWith(vi.fn(), {
        getRoom: async () => null,
        getWorld: async () => null,
        getSetting: () => undefined,
      } as unknown as Partial<IAgentRuntime>),
      message(),
    );
    expect(granted).toBe(false);
  });

  it("grants when entity is canonical owner (OWNER outranks ADMIN)", async () => {
    const granted = await hasAdminAccess(
      runtimeWith(vi.fn(), {
        getSetting: (key: string) =>
          key === "ELIZA_ADMIN_ENTITY_ID" ? ENTITY_ID : undefined,
      } as unknown as Partial<IAgentRuntime>),
      message(),
    );
    expect(granted).toBe(true);
  });

  it("grants when entity is ADMIN via world role", async () => {
    const worldId = "00000000-0000-0000-0000-0000000000ee" as UUID;
    const room: Room = {
      id: message().roomId,
      agentId: AGENT_ID,
      source: "test",
      type: "PRIVATE",
      worldId,
    };
    const world: World = {
      id: worldId,
      agentId: AGENT_ID,
      name: "test",
      metadata: { roles: { [ENTITY_ID]: "ADMIN" } },
    };
    const granted = await hasAdminAccess(
      runtimeWith(vi.fn(), {
        getRoom: async () => room,
        getWorld: async () => world,
      } as unknown as Partial<IAgentRuntime>),
      message(),
    );
    expect(granted).toBe(true);
  });
});

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
    // Core role resolution may report its narrower failing scopes first; this
    // wrapper must still publish its own authorization-boundary observation.
    expect(reportError).toHaveBeenCalledWith(
      "Access.hasPrivateAccess",
      expect.any(Error),
      { entityId: ENTITY_ID },
    );
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
