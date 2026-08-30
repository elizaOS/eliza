/**
 * Verifies that timing scenarios carry the decision speaker as sender metadata
 * without placing a bracketed name in message text, which the runtime would
 * interpret as an addressee and suppress as a turn meant for someone else.
 */
import { describe, expect, it } from "bun:test";
import { buildGroupChatTimingSetup } from "./_factory.ts";
import silentScenario from "./groupchat.w2s.silent.ambient.001.scenario.ts";

describe("group-chat timing scenario factory", () => {
  it("keeps sender identity out of the decision text", () => {
    const setup = buildGroupChatTimingSetup({
      id: "test.timing.sender",
      title: "test",
      label: "speak",
      directlyAddressed: false,
      context: [{ speaker: "Speaker_0", text: "context" }],
      decisionTurn: { speaker: "Speaker_1", text: "open question" },
      sourceRow: "fixture",
    });

    expect(setup.decisionTurn.text).toBe("open question");
    expect(setup.decisionTurn.content).toEqual({ senderName: "Speaker_1" });
  });

  it("requires literal silence for a SILENT corpus label", () => {
    const turn = silentScenario.turns[0];
    if (turn?.kind !== "message" || !turn.assertResponse) {
      throw new Error("fixture must expose the SILENT response assertion");
    }

    expect(turn.assertResponse("")).toBeUndefined();
    expect(turn.assertResponse("👍")).toContain("expected no agent response");
  });
});
