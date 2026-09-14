/**
 * Cross-channel search integrity tests with a deterministic runtime double.
 *
 * The harness verifies that model-facing results survive internal database
 * pagination and that the retired caller limit cannot silently hide context.
 */

import type { IAgentRuntime, Memory, Room, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runCrossChannelSearch } from "./cross-channel-search";

const ROOM_ID = "00000000-0000-0000-0000-000000000001" as UUID;

function memoryAt(index: number): Memory {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` as UUID,
    entityId:
      `00000000-0000-4000-8001-${String(index).padStart(12, "0")}` as UUID,
    agentId: "00000000-0000-0000-0000-000000000002" as UUID,
    roomId: ROOM_ID,
    content: { text: `complete memory ${index}`, source: "discord" },
    createdAt: index,
  };
}

describe("cross-channel search context integrity", () => {
  it("returns every memory across internal pages even when a legacy limit is supplied", async () => {
    const memories = Array.from({ length: 501 }, (_, index) => memoryAt(index));
    const searchMemories = vi.fn(
      async (params: {
        offset?: number;
        limit?: number;
      }): Promise<Memory[]> => {
        const offset = params.offset ?? 0;
        const limit = params.limit ?? memories.length;
        return memories.slice(offset, offset + limit);
      },
    );
    const runtime = {
      useModel: vi.fn(async () => [0.1, 0.2, 0.3]),
      searchMemories,
      getRoom: vi.fn(
        async () =>
          ({ id: ROOM_ID, name: "complete room", source: "memory" }) as Room,
      ),
    } as unknown as IAgentRuntime;

    const result = await runCrossChannelSearch(runtime, {
      query: "complete",
      channels: ["memory"],
      limit: 1,
    });

    expect(result.hits).toHaveLength(501);
    expect(new Set(result.hits.map((hit) => hit.text)).size).toBe(501);
    expect(searchMemories).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ limit: 500, offset: 0 }),
    );
    expect(searchMemories).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ limit: 500, offset: 500 }),
    );
  });
});
