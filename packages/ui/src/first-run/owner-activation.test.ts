/**
 * Deterministic tests for the client activation handoff: it targets the
 * selected agent's preferred conversation, falls back to the authoritative
 * list, and creates a private conversation only when the agent has none.
 */

import { describe, expect, it, vi } from "vitest";
import type { Conversation } from "../api";
import {
  activateOwnerAfterFirstRun,
  type OwnerActivationClient,
} from "./owner-activation";

function conversation(id: string, roomId: string): Conversation {
  return {
    id,
    roomId,
    title: "Chat",
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
  };
}

function client(conversations: Conversation[]): OwnerActivationClient & {
  createConversation: ReturnType<typeof vi.fn>;
  activateOwnerFirstRun: ReturnType<typeof vi.fn>;
} {
  const created = conversation("created", "created-room");
  return {
    listConversations: vi.fn(async () => ({ conversations })),
    createConversation: vi.fn(async () => ({ conversation: created })),
    activateOwnerFirstRun: vi.fn(async (roomId: string) => ({
      outcome: "activated" as const,
      entry: { status: "complete" as const, roomId },
    })),
  };
}

describe("activateOwnerAfterFirstRun", () => {
  it("targets the preferred conversation when it belongs to the selected agent", async () => {
    const api = client([
      conversation("recent", "room-recent"),
      conversation("preferred", "room-preferred"),
    ]);
    const result = await activateOwnerAfterFirstRun(api, "preferred");
    expect(result.conversation.id).toBe("preferred");
    expect(api.activateOwnerFirstRun).toHaveBeenCalledWith("room-preferred");
    expect(api.createConversation).not.toHaveBeenCalled();
  });

  it("does not trust a preferred id absent from the selected agent's list", async () => {
    const api = client([conversation("selected", "selected-room")]);
    await activateOwnerAfterFirstRun(api, "stale-other-agent-id");
    expect(api.activateOwnerFirstRun).toHaveBeenCalledWith("selected-room");
  });

  it("creates the selected agent's first conversation before activation", async () => {
    const api = client([]);
    const result = await activateOwnerAfterFirstRun(api);
    expect(result.conversation.id).toBe("created");
    expect(api.createConversation).toHaveBeenCalledTimes(1);
    expect(api.activateOwnerFirstRun).toHaveBeenCalledWith("created-room");
  });

  it("does not complete locally when the activation boundary fails", async () => {
    const api = client([conversation("selected", "selected-room")]);
    api.activateOwnerFirstRun.mockRejectedValueOnce(new Error("retryable 503"));
    await expect(activateOwnerAfterFirstRun(api)).rejects.toThrow(
      "retryable 503",
    );
  });
});
