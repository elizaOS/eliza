import { describe, expect, it } from "vitest";

import { shouldRespondToVoiceTurn } from "./should-respond";

describe("shouldRespondToVoiceTurn", () => {
  it("responds to real questions and commands", () => {
    expect(shouldRespondToVoiceTurn("what time is it?")).toBe(true);
    expect(shouldRespondToVoiceTurn("turn on the kitchen lights")).toBe(true);
    expect(shouldRespondToVoiceTurn("go home")).toBe(true);
  });

  it("responds to short answers (must NOT be suppressed)", () => {
    expect(shouldRespondToVoiceTurn("yes")).toBe(true);
    expect(shouldRespondToVoiceTurn("stop")).toBe(true);
    expect(shouldRespondToVoiceTurn("the blue one")).toBe(true);
  });

  it("ignores pure disfluency / thinking noises", () => {
    expect(shouldRespondToVoiceTurn("um")).toBe(false);
    expect(shouldRespondToVoiceTurn("uh")).toBe(false);
    expect(shouldRespondToVoiceTurn("hmm")).toBe(false);
    expect(shouldRespondToVoiceTurn("um uh erm")).toBe(false);
    expect(shouldRespondToVoiceTurn("er ah")).toBe(false);
  });

  it("does NOT over-suppress an ambiguous clarification ('huh?')", () => {
    // Better to occasionally answer a backchannel than to ignore a real
    // clarification request — so "huh" is intentionally not a disfluency.
    expect(shouldRespondToVoiceTurn("huh")).toBe(true);
  });

  it("ignores empty/whitespace", () => {
    expect(shouldRespondToVoiceTurn("")).toBe(false);
    expect(shouldRespondToVoiceTurn("   ")).toBe(false);
  });

  it("suppresses a near-verbatim echo of the agent's recent reply (self-trigger)", () => {
    const reply = "It is sunny and seventy two degrees in San Francisco today.";
    expect(
      shouldRespondToVoiceTurn(
        "it is sunny and seventy two degrees in san francisco today",
        { recentAgentReply: reply, replyAgeMs: 500 },
      ),
    ).toBe(false);
  });

  it("does NOT suppress a genuine follow-up that merely shares a few words", () => {
    const reply = "It is sunny and seventy two degrees in San Francisco today.";
    expect(
      shouldRespondToVoiceTurn("what about tomorrow in new york", {
        recentAgentReply: reply,
        replyAgeMs: 500,
      }),
    ).toBe(true);
  });

  it("only applies the echo guard while the reply is recent", () => {
    const reply = "turn on the lights";
    // Stale reply → the same words are treated as a fresh command, not echo.
    expect(
      shouldRespondToVoiceTurn("turn on the lights", {
        recentAgentReply: reply,
        replyAgeMs: 60_000,
      }),
    ).toBe(true);
  });

  it("applies the echo guard while the agent is still speaking, even for an 'old' reply", () => {
    // A long reply: its message is old (age past the window) but the agent is
    // still speaking it, so the echo bleeding into the mic must be suppressed.
    expect(
      shouldRespondToVoiceTurn("turn on the lights", {
        recentAgentReply: "turn on the lights",
        replyAgeMs: 60_000,
        agentSpeaking: true,
      }),
    ).toBe(false);
  });

  it("does not suppress a one-word turn just because it appears in the reply", () => {
    expect(
      shouldRespondToVoiceTurn("stop", {
        recentAgentReply: "I will stop the timer now.",
        replyAgeMs: 200,
      }),
    ).toBe(true);
  });
});
