/**
 * Unit coverage for the selfcontrol role check wrapper.
 *
 * Behavioral risk: a null result from the core role check means the
 * world/room/entity setup is broken. The wrapper must surface that as an
 * explicit error (with the offending ids) instead of silently hiding the
 * action from the LLM — a silent null would make gated actions disappear
 * without any diagnosable signal.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { checkSenderRoleMock } = vi.hoisted(() => ({
  checkSenderRoleMock: vi.fn(),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    checkSenderRole: checkSenderRoleMock,
  };
});

import { checkSenderRole } from "./roles.ts";

const runtime = { agentId: "agent-123" } as never;
const message = {
  roomId: "room-456",
  entityId: "entity-789",
} as never;

beforeEach(() => {
  checkSenderRoleMock.mockReset();
});

describe("checkSenderRole", () => {
  it("passes through a valid role result", async () => {
    const result = { role: "admin", ok: true };
    checkSenderRoleMock.mockResolvedValue(result);
    await expect(checkSenderRole(runtime, message)).resolves.toBe(result);
    expect(checkSenderRoleMock).toHaveBeenCalledWith(runtime, message);
  });

  it("throws a descriptive error when the core check returns null", async () => {
    checkSenderRoleMock.mockResolvedValue(null);
    await expect(checkSenderRole(runtime, message)).rejects.toThrow(
      /checkSenderRole returned null/,
    );
    await expect(checkSenderRole(runtime, message)).rejects.toThrow(
      /roomId=room-456/,
    );
    await expect(checkSenderRole(runtime, message)).rejects.toThrow(
      /entityId=entity-789/,
    );
    await expect(checkSenderRole(runtime, message)).rejects.toThrow(
      /agentId=agent-123/,
    );
  });

  it("does not swallow undefined results (treats as broken setup too)", async () => {
    checkSenderRoleMock.mockResolvedValue(undefined);
    await expect(checkSenderRole(runtime, message)).rejects.toThrow(
      /checkSenderRole returned null/,
    );
  });
});
