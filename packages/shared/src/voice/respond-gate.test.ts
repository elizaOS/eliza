/**
 * Tests the voice respond-gate (shouldRespondToVoiceTurn, buildVoiceTurnSignal):
 * disfluency/echo suppression, bystander vs enrolled-speaker gating, wake-word
 * rescue, and acoustic self-voice rejection of the agent's own mis-transcribed
 * output. Pure functions, no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  AGENT_SELF_VOICE_THRESHOLD,
  buildVoiceTurnSignal,
  shouldRespondToVoiceTurn,
} from "./respond-gate";

describe("shouldRespondToVoiceTurn", () => {
  it("ignores pure disfluency and empty turns", () => {
    expect(shouldRespondToVoiceTurn("um uh hmm")).toBe(false);
    expect(shouldRespondToVoiceTurn("   ")).toBe(false);
    expect(shouldRespondToVoiceTurn("set a timer")).toBe(true);
  });

  it("suppresses a near-verbatim transcript echo of a recent reply", () => {
    const reply = "the meeting is at three pm in the blue room";
    expect(
      shouldRespondToVoiceTurn("the meeting is at three pm in the blue room", {
        recentAgentReply: reply,
        agentSpeaking: true,
      }),
    ).toBe(false);
    // A genuine new question with low overlap still passes.
    expect(
      shouldRespondToVoiceTurn("what time is it now", {
        recentAgentReply: reply,
        agentSpeaking: true,
      }),
    ).toBe(true);
  });
});

describe("buildVoiceTurnSignal — bystander + wake word", () => {
  it("answers an enrolled speaker, suppresses a confident bystander", () => {
    const enrolled = buildVoiceTurnSignal("turn on the lights", {
      speaker: { entityId: "e-owner", confidence: 0.9, isOwner: true },
      knownSpeakerEntityIds: ["e-owner"],
    });
    expect(enrolled.agentShouldSpeak).toBe(true);

    const bystander = buildVoiceTurnSignal("turn on the lights", {
      speaker: { entityId: "e-stranger", confidence: 0.9 },
      knownSpeakerEntityIds: ["e-owner"],
    });
    expect(bystander.agentShouldSpeak).toBe(false);
    expect(bystander.nextSpeaker).toBe("user");
  });

  it("wake word rescues a bystander", () => {
    const r = buildVoiceTurnSignal("turn on the lights", {
      speaker: { entityId: "e-stranger", confidence: 0.9 },
      knownSpeakerEntityIds: ["e-owner"],
      wakeWordActive: true,
    });
    expect(r.agentShouldSpeak).toBe(true);
  });
});

describe("buildVoiceTurnSignal — acoustic self-voice rejection", () => {
  it("suppresses a MIS-TRANSCRIBED echo the word-overlap guard misses", () => {
    // Transcript shares NO words with the recent reply, so the transcript echo
    // guard passes it — but the speaker embedding matches the agent's own voice.
    const r = buildVoiceTurnSignal("zorp blampf widget", {
      recentAgentReply: "the weather today is sunny and warm",
      agentSpeaking: true,
      selfVoiceSimilarity: 0.85,
    });
    expect(r.agentShouldSpeak).toBe(false);
    expect(r.source).toBe("client-ambient+self-voice");
  });

  it("self-voice suppression survives the wake word (the agent said 'hey eliza')", () => {
    const r = buildVoiceTurnSignal("hey eliza what is next", {
      agentSpeaking: true,
      wakeWordActive: true,
      selfVoiceSimilarity: 0.9,
    });
    expect(r.agentShouldSpeak).toBe(false);
  });

  it("does NOT suppress the real user just because they spoke recently", () => {
    // Low self-voice similarity = it's a different (human) voice → answer it.
    const r = buildVoiceTurnSignal("what is on my calendar", {
      recentAgentReply: "here is your schedule",
      replyAgeMs: 1000,
      selfVoiceSimilarity: 0.2,
    });
    expect(r.agentShouldSpeak).toBe(true);
  });

  it("does not fire on a stale match (no recent reply, not speaking)", () => {
    const r = buildVoiceTurnSignal("zorp blampf widget", {
      selfVoiceSimilarity: 0.95,
      replyAgeMs: 60_000,
    });
    // Nonsense words → transcript gate passes; no recency → self-voice inert.
    expect(r.agentShouldSpeak).toBe(true);
  });

  it("threshold is a sane cosine bound", () => {
    expect(AGENT_SELF_VOICE_THRESHOLD).toBeGreaterThan(0.5);
    expect(AGENT_SELF_VOICE_THRESHOLD).toBeLessThan(0.78);
  });
});
