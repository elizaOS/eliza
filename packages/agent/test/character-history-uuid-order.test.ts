/**
 * Character history is newest-first. Two edits in the same millisecond must
 * keep the higher UUID when the page is shorter than the tie.
 */
import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { listCharacterHistory } from "../src/services/character-history.ts";

const AGENT = "11111111-1111-4111-8111-111111111111" as UUID;
const ROOM = "22222222-2222-4222-8222-222222222222" as UUID;
const LOWER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as UUID;
const UPPER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as UUID;
const SAME = 1_700_000_000_000;

function historyMemory(id: UUID): Memory {
  return {
    id,
    entityId: AGENT,
    agentId: AGENT,
    roomId: ROOM,
    createdAt: SAME,
    content: { text: `edit ${id}` },
    metadata: {
      action: "character_updated",
      timestamp: SAME,
      historySource: "manual",
      changes: [{ field: "name", before: "Ada", after: "Eve" }],
      before: { name: "Ada" },
      after: { name: "Eve" },
    },
  };
}

describe("listCharacterHistory UUID ties", () => {
  it("keeps the higher UUID when two edits share a millisecond and the page holds one", async () => {
    const runtime = {
      agentId: AGENT,
      getMemories: async () => [historyMemory(LOWER), historyMemory(UPPER)],
    } as unknown as IAgentRuntime;

    const page = await listCharacterHistory(runtime, 1);

    expect(page.map((entry) => entry.id)).toEqual([UPPER]);
  });
});
