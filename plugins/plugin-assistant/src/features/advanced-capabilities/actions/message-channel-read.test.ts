/** Exercises channel range limits through MESSAGE's public action handler. */
import type { Memory, Room, UUID } from "@elizaos/core";
import { createMockRuntime } from "@elizaos/testing";
import { describe, expect, it, vi } from "vitest";
import { messageAction } from "./message.ts";

const roomId = "00000000-0000-4000-8000-000000000003" as UUID;
const request = {
  roomId,
  entityId: "00000000-0000-4000-8000-000000000002",
  agentId: "00000000-0000-4000-8000-000000000001",
  content: { text: "Read this channel", source: "discord" },
} as Memory;

function fixture() {
  const getMemories = vi.fn(async () => []);
  const runtime = createMockRuntime({
    getMessageConnectors: () => [],
    getRoom: async () => ({ id: roomId, name: "general" }) as Room,
    getMemories,
  });
  const read = (parameters: Record<string, unknown>) =>
    messageAction.handler(runtime, request, undefined, {
      parameters: { action: "read_channel", channel: roomId, ...parameters },
    });
  return { getMemories, read };
}

describe("MESSAGE channel read limits", () => {
  it("preserves explicit recent limits and an unrestricted dated range", async () => {
    const { read, getMemories } = fixture();
    expect((await read({ limit: 3 }))?.success).toBe(true);
    expect(getMemories).toHaveBeenLastCalledWith(
      expect.objectContaining({ roomId, count: 3 }),
    );
    expect((await read({ range: "dates", from: "2026-01-01" }))?.success).toBe(
      true,
    );
    expect(getMemories).toHaveBeenLastCalledWith(
      expect.objectContaining({
        roomId,
        count: undefined,
        start: Date.parse("2026-01-01"),
      }),
    );
  });

  it.each([0, -1, 1.5, "invalid", Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid explicit limit %s before fetching",
    async (limit) => {
      const { read, getMemories } = fixture();
      expect(await read({ limit })).toMatchObject({
        success: false,
        values: { error: "INVALID_PARAMETERS" },
      });
      expect(getMemories).not.toHaveBeenCalled();
    },
  );
});
