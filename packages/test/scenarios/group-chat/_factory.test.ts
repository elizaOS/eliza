/**
 * Verifies that timing scenarios carry the decision speaker as sender metadata
 * without placing a bracketed name in message text, which the runtime would
 * interpret as an addressee and suppress as a turn meant for someone else.
 */
import { describe, expect, it } from "bun:test";
import { buildGroupChatTimingScenario } from "./_factory.ts";

describe("group-chat timing scenario factory", () => {
  it("keeps sender identity out of the decision text", () => {
    const scenario = buildGroupChatTimingScenario({
      id: "test.timing.sender",
      title: "test",
      label: "speak",
      directlyAddressed: false,
      context: [{ speaker: "Speaker_0", text: "context" }],
      decisionTurn: { speaker: "Speaker_1", text: "open question" },
      sourceRow: "fixture",
    });

    expect(scenario.turns[0]?.text).toBe("open question");
    expect(scenario.turns[0]?.content).toEqual({ senderName: "Speaker_1" });
  });
});
