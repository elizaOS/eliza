/**
 * Verifies that Instagram connector reads preserve complete stored history
 * when the caller did not request pagination, using a mocked runtime database.
 */
import type { IAgentRuntime, Memory, TargetInfo, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { InstagramService } from "../service.js";

describe("Instagram connector history", () => {
  it("returns every stored message when limit is omitted", async () => {
    const roomId = "00000000-0000-4000-8000-000000000001" as UUID;
    const memories = Array.from({ length: 501 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      roomId,
      content: { text: `message ${index}` },
      createdAt: index,
    })) as Memory[];
    const getMemories = vi.fn(async () => memories);
    const runtime = {
      getMemories,
      getRoom: vi.fn(async () => ({ channelId: "thread-1" })),
    } as unknown as IAgentRuntime;
    const service = Object.create(InstagramService.prototype) as InstagramService;

    const result = await service.fetchConnectorMessages(
      { runtime, target: { source: "instagram", roomId } as TargetInfo },
      {}
    );

    expect(result).toHaveLength(501);
    expect(getMemories).toHaveBeenCalledWith(
      expect.not.objectContaining({ limit: expect.anything() })
    );
  });
});
