/**
 * Verifies that activity-profile message loading exhausts storage pagination
 * instead of silently analyzing only the first fixed-size window.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { loadAllRoomMessagesForActivityProfile } from "./service.js";

describe("activity profile message pagination", () => {
  it("returns every message beyond the former 500-row cap", async () => {
    const roomId = "00000000-0000-0000-0000-000000000001" as UUID;
    const rows = Array.from(
      { length: 1_205 },
      (_, index) =>
        ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          roomId,
        }) as Memory,
    );
    const getMemoriesByRoomIds = vi.fn(
      async ({
        limit = rows.length,
        offset = 0,
      }: {
        limit?: number;
        offset?: number;
      }) => rows.slice(offset, offset + limit),
    );
    const runtime = { getMemoriesByRoomIds } as unknown as IAgentRuntime;

    const result = await loadAllRoomMessagesForActivityProfile(runtime, [
      roomId,
    ]);

    expect(result).toEqual(rows);
    expect(getMemoriesByRoomIds).toHaveBeenCalledTimes(3);
    expect(getMemoriesByRoomIds).toHaveBeenLastCalledWith({
      tableName: "messages",
      roomIds: [roomId],
      limit: 500,
      offset: 1_000,
    });
  });
});
