import { describe, expect, it } from "vitest";
import { buildVoiceTurnSignal, shouldRespondToVoiceTurn } from "./respond-gate";

describe("shouldRespondToVoiceTurn", () => {
  it("answers a turn that is not written in Latin letters", () => {
    for (const turn of [
      "打开客厅的灯",
      "打开客厅的灯。",
      "客厅の電気をつけて",
      "거실 불 켜 줘",
      "включи свет в гостиной",
    ]) {
      expect(shouldRespondToVoiceTurn(turn), turn).toBe(true);
      expect(buildVoiceTurnSignal(turn).agentShouldSpeak, turn).toBe(true);
    }
  });

  it("still ignores a pure disfluency and a spoken echo of the agent", () => {
    expect(shouldRespondToVoiceTurn("um")).toBe(false);
    const recentAgentReply = "I will turn on the kitchen lights now.";
    expect(
      shouldRespondToVoiceTurn("turn on the kitchen lights now", {
        recentAgentReply,
        replyAgeMs: 500,
      }),
    ).toBe(false);
    expect(
      shouldRespondToVoiceTurn("turn off the porch light", {
        recentAgentReply,
        replyAgeMs: 500,
      }),
    ).toBe(true);
  });
});
