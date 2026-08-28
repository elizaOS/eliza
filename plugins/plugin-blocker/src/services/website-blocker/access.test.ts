import { logger } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rolesMock = vi.hoisted(() => ({ checkSenderRole: vi.fn() }));
vi.mock("./roles.ts", () => ({ checkSenderRole: rolesMock.checkSenderRole }));

const agentAccessMock = vi.hoisted(() => ({ hasOwnerAccess: vi.fn() }));
vi.mock("@elizaos/agent/security/access", () => ({
  hasOwnerAccess: agentAccessMock.hasOwnerAccess,
}));

import { getSelfControlAccess, SELFCONTROL_ACCESS_ERROR } from "./access.ts";

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    runtime: { agentId: "agent-1" },
    message: { entityId: "entity-1", roomId: "room-1" },
    ...overrides,
  };
}

describe("getSelfControlAccess", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows an OWNER via the fast path when principal and owner metadata are present", async () => {
    agentAccessMock.hasOwnerAccess.mockResolvedValue(true);
    const { runtime, message } = makeCtx();
    const result = await getSelfControlAccess(
      runtime as never,
      message as never,
    );
    expect(result).toEqual({ allowed: true, role: "OWNER" });
    expect(agentAccessMock.hasOwnerAccess).toHaveBeenCalledWith(
      runtime,
      message,
    );
    expect(rolesMock.checkSenderRole).not.toHaveBeenCalled();
  });

  it("skips the owner-metadata fast path when the entity principal is missing", async () => {
    const { runtime, message } = makeCtx({ message: { roomId: "room-1" } });
    rolesMock.checkSenderRole.mockResolvedValue({
      isOwner: true,
      role: "OWNER",
    });
    const result = await getSelfControlAccess(
      runtime as never,
      message as never,
    );
    expect(agentAccessMock.hasOwnerAccess).not.toHaveBeenCalled();
    expect(result.allowed).toBe(true);
    expect(result.role).toBe("OWNER");
  });

  it("skips the fast path when owner metadata says no", async () => {
    agentAccessMock.hasOwnerAccess.mockResolvedValue(false);
    rolesMock.checkSenderRole.mockResolvedValue({
      isOwner: true,
      role: "OWNER",
    });
    const { runtime, message } = makeCtx();
    const result = await getSelfControlAccess(
      runtime as never,
      message as never,
    );
    expect(result.allowed).toBe(true);
    expect(rolesMock.checkSenderRole).toHaveBeenCalled();
  });

  it("denies non-owner roles with the restricted-to-OWNER reason", async () => {
    agentAccessMock.hasOwnerAccess.mockResolvedValue(false);
    rolesMock.checkSenderRole.mockResolvedValue({
      isOwner: false,
      role: "MEMBER",
    });
    const { runtime, message } = makeCtx();
    const result = await getSelfControlAccess(
      runtime as never,
      message as never,
    );
    expect(result).toEqual({
      allowed: false,
      role: "MEMBER",
      reason: SELFCONTROL_ACCESS_ERROR,
    });
  });

  it("denies when the role check reports no role at all", async () => {
    agentAccessMock.hasOwnerAccess.mockResolvedValue(false);
    rolesMock.checkSenderRole.mockResolvedValue({
      isOwner: false,
      role: null,
    });
    const { runtime, message } = makeCtx();
    const result = await getSelfControlAccess(
      runtime as never,
      message as never,
    );
    expect(result.allowed).toBe(false);
    expect(result.role).toBeNull();
    expect(result.reason).toBe(SELFCONTROL_ACCESS_ERROR);
  });

  it("fails closed (denies, never throws) when the role check blows up", async () => {
    agentAccessMock.hasOwnerAccess.mockResolvedValue(false);
    rolesMock.checkSenderRole.mockRejectedValue(
      new Error("world/room/entity setup is broken"),
    );
    const errorSpy = vi.spyOn(logger, "error");
    const { runtime, message } = makeCtx();
    const result = await getSelfControlAccess(
      runtime as never,
      message as never,
    );
    expect(result.allowed).toBe(false);
    expect(result.role).toBeNull();
    expect(result.reason).toContain("Website blocking is unavailable");
    expect(result.reason).toContain("world/room/entity setup is broken");
    expect(errorSpy).toHaveBeenCalled();
  });
});
