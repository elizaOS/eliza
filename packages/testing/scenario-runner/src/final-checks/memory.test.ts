import type { Memory, UUID } from "@elizaos/core";
import { expect, it, vi } from "vitest";
import { runFinalCheck } from "./index.ts";

const room = "00000000-0000-0000-0000-000000000001";
it("checks persisted memory rather than a write that was later deleted", async () => {
  const getMemories = vi.fn().mockResolvedValue([]);
  const result = await runFinalCheck(
    { type: "memoryExists", content: { text: "remember" } },
    {
      runtime: { getMemories },
      ctx: {
        primaryRoomId: room,
        actionsCalled: [],
        memoryWrites: [{ table: "messages", content: { text: "remember" } }],
      },
    },
  );
  expect(result.status).toBe("failed");
});

it("finds seeded memories beyond the first page within the scenario room", async () => {
  const first = Array.from({ length: 100 }, (_, index) => ({
    id: `${room.slice(0, -3)}${String(index).padStart(3, "0")}` as UUID,
    createdAt: index,
    content: { text: "other" },
  })) as Memory[];
  const getMemories = vi
    .fn()
    .mockResolvedValueOnce(first)
    .mockResolvedValueOnce([{ content: { text: "remember" } }]);
  const result = await runFinalCheck(
    { type: "memoryExists", content: { text: "remember" } },
    {
      runtime: { getMemories },
      ctx: { primaryRoomId: room, actionsCalled: [] },
    },
  );
  expect(result.status).toBe("passed");
  expect(getMemories).toHaveBeenLastCalledWith(
    expect.objectContaining({
      roomId: room,
      cursor: { createdAt: 99, id: first[99].id },
    }),
  );
});
