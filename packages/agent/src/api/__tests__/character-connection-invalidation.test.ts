/**
 * Verifies character renames invalidate connection proofs before persisting the
 * new topology, so old-name completions cannot become ready afterward.
 */
import { type AgentRuntime, stringToUuid, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type CharacterRouteContext,
  handleCharacterRoutes,
} from "../character-routes.ts";
import {
  captureConversationConnectionDescriptor,
  hasReadyConversationConnection,
  scheduleConversationConnectionEnsure,
} from "../conversation-connection-readiness.ts";

function captureDescriptor(runtime: AgentRuntime, agentName: string) {
  return captureConversationConnectionDescriptor({
    runtime,
    conversationId: "rename-conversation",
    roomId: stringToUuid("rename-room") as UUID,
    agentName,
    worldId: stringToUuid(`${agentName}-web-chat-world`) as UUID,
    messageServerId: stringToUuid(`${agentName}-web-server`) as UUID,
    channelId: "web-conv-rename-conversation",
    ownerId: stringToUuid("rename-owner") as UUID,
    callerEntityId: stringToUuid("rename-caller") as UUID,
    callerRole: "USER",
    callerUserName: "rename-caller",
  });
}

describe("character connection topology invalidation", () => {
  it("invalidates the old-name proof through the PUT character route", async () => {
    const runtime = {
      agentId: stringToUuid("rename-agent") as UUID,
      character: {
        name: "Old Name",
        settings: {},
      },
      updateAgent: vi.fn(async () => undefined),
      createMemory: vi.fn(async () => undefined),
    } as unknown as AgentRuntime;
    const oldDescriptor = captureDescriptor(runtime, "Old Name");
    await scheduleConversationConnectionEnsure(oldDescriptor, async () => {});
    expect(hasReadyConversationConnection(oldDescriptor)).toBe(true);

    const json = vi.fn();
    const handled = await handleCharacterRoutes({
      req: { url: "/api/character" },
      res: {},
      method: "PUT",
      pathname: "/api/character",
      state: {
        runtime,
        agentName: "Old Name",
      },
      readJsonBody: vi.fn(async () => ({ name: "New Name" })),
      json,
      error: vi.fn(),
      pickRandomNames: vi.fn(() => ["Unused"]),
      validateCharacter: vi.fn(() => ({ success: true })),
    } as unknown as CharacterRouteContext);

    expect(handled).toBe(true);
    expect(runtime.character.name).toBe("New Name");
    expect(runtime.updateAgent).toHaveBeenCalledTimes(1);
    expect(json).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ok: true, agentName: "New Name" }),
    );
    expect(hasReadyConversationConnection(oldDescriptor)).toBe(false);
    expect(
      hasReadyConversationConnection(captureDescriptor(runtime, "New Name")),
    ).toBe(false);
  });
});
