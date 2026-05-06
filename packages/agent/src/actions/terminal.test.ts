import type { IAgentRuntime, Memory } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { terminalAction } from "./terminal";

vi.mock("../security/access.js", () => ({
  hasOwnerAccess: vi.fn(async () => false),
}));

describe("SHELL_COMMAND action", () => {
  it("stops post-action continuation when terminal access is denied", async () => {
    const result = await terminalAction.handler?.(
      { agentId: "agent-id" } as IAgentRuntime,
      {
        agentId: "agent-id",
        entityId: "not-owner",
        roomId: "room-id",
        content: {},
      } as Memory,
    );

    expect(result).toMatchObject({
      success: false,
      text: "Permission denied: only the owner may run terminal commands.",
      data: {
        actionName: "SHELL_COMMAND",
        suppressPostActionContinuation: true,
        terminal: { permissionDenied: true },
      },
    });
  });
});
