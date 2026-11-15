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

  it("answers a short reply that repeats the question once the agent finished speaking", () => {
    const recentAgentReply = "Should I call Alex or Sam?";
    expect(
      shouldRespondToVoiceTurn("Call Alex", {
        recentAgentReply,
        replyAgeMs: 3000,
        turnStartedAfterReplyEndMs: 2400,
      }),
    ).toBe(true);
    // Started while the reply was still playing: its tail in the mic.
    expect(
      shouldRespondToVoiceTurn("Call Alex", {
        recentAgentReply,
        replyAgeMs: 3000,
        turnStartedAfterReplyEndMs: -200,
      }),
    ).toBe(false);
    // An echo canceller leaves no tail after playback.
    expect(
      shouldRespondToVoiceTurn("Call Alex", {
        recentAgentReply,
        replyAgeMs: 300,
        turnStartedAfterReplyEndMs: -200,
        echoCancelled: true,
      }),
    ).toBe(true);
    // No start offset: only the short fallback window applies.
    expect(
      shouldRespondToVoiceTurn("Call Alex", {
        recentAgentReply,
        replyAgeMs: 5000,
      }),
    ).toBe(true);
    expect(
      shouldRespondToVoiceTurn("Call Alex", {
        recentAgentReply,
        replyAgeMs: 2000,
      }),
    ).toBe(false);
  });

  it("drops a verbatim echo while the agent is speaking, echo canceller or not", () => {
    for (const echoCancelled of [false, true])
      expect(
        shouldRespondToVoiceTurn("should I call Alex or Sam", {
          recentAgentReply: "Should I call Alex or Sam?",
          replyAgeMs: 60_000,
          agentSpeaking: true,
          echoCancelled,
        }),
      ).toBe(false);
  });
});
