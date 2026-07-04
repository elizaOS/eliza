/**
 * Unit coverage for building the voice-turn signal (complete + addressed →
 * agent speaks). Pure function, no live ASR.
 */
import { describe, expect, it } from "vitest";

import { buildVoiceTurnSignal } from "./voice-turn-signal";

describe("buildVoiceTurnSignal", () => {
  it("lets a complete, addressed turn through (agent speaks)", () => {
    const s = buildVoiceTurnSignal("what time is it?");
    expect(s.agentShouldSpeak).toBe(true);
    expect(s.nextSpeaker).toBe("agent");
    expect(s.endOfTurnProbability).toBeGreaterThanOrEqual(0.4);
    expect(s.source).toBe("client-ambient");
  });

  it("suppresses pure disfluency via the transcript gate", () => {
    const s = buildVoiceTurnSignal("um uh");
    expect(s.agentShouldSpeak).toBe(false);
    expect(s.nextSpeaker).toBe("user");
  });

  it("suppresses a near-verbatim echo of the agent's recent reply", () => {
    const reply = "It is sunny and seventy two degrees in San Francisco today.";
    const s = buildVoiceTurnSignal(
      "it is sunny and seventy two degrees in san francisco today",
      { recentAgentReply: reply, replyAgeMs: 400, agentSpeaking: true },
    );
    expect(s.agentShouldSpeak).toBe(false);
  });

  it("marks a mid-clause turn as nextSpeaker=user (low EOT) even if otherwise speakable", () => {
    // A trailing conjunction reads as not-yet-done → low EOT → server holds.
    const s = buildVoiceTurnSignal("turn on the lights and");
    expect(s.endOfTurnProbability).toBeLessThan(0.4);
    expect(s.nextSpeaker).toBe("user");
  });

  describe("speaker attribution (diarization)", () => {
    it("suppresses a confident bystander who is not enrolled", () => {
      const s = buildVoiceTurnSignal("did you watch the game last night", {
        speaker: { entityId: "entity-stranger", confidence: 0.92 },
      });
      expect(s.agentShouldSpeak).toBe(false);
      expect(s.source).toBe("client-ambient+diarization");
    });

    it("does NOT suppress an uncertain attribution (fail open)", () => {
      const s = buildVoiceTurnSignal("did you watch the game last night", {
        speaker: { entityId: "entity-stranger", confidence: 0.55 },
      });
      expect(s.agentShouldSpeak).toBe(true);
    });

    it("does NOT suppress the owner", () => {
      const s = buildVoiceTurnSignal("did you watch the game last night", {
        speaker: { entityId: "entity-owner", confidence: 0.95, isOwner: true },
      });
      expect(s.agentShouldSpeak).toBe(true);
    });

    it("does NOT suppress an enrolled (known) speaker", () => {
      const s = buildVoiceTurnSignal("did you watch the game last night", {
        speaker: { entityId: "entity-roommate", confidence: 0.95 },
        knownSpeakerEntityIds: ["entity-owner", "entity-roommate"],
      });
      expect(s.agentShouldSpeak).toBe(true);
    });

    it("does NOT suppress an unknown speaker with no entity id", () => {
      // entityId null = diarizer couldn't attribute; treat as the user, not a
      // bystander to silence.
      const s = buildVoiceTurnSignal("what's the weather", {
        speaker: { entityId: null, confidence: 0.99 },
      });
      expect(s.agentShouldSpeak).toBe(true);
    });
  });

  describe("wake word", () => {
    it("overrides a confident-bystander suppression (explicit address)", () => {
      const s = buildVoiceTurnSignal("hey eliza what time is it", {
        speaker: { entityId: "entity-stranger", confidence: 0.95 },
        wakeWordActive: true,
      });
      expect(s.agentShouldSpeak).toBe(true);
      expect(s.source).toBe("client-ambient+wakeword");
    });

    it("overrides a transcript-gate disfluency miss", () => {
      const s = buildVoiceTurnSignal("um", { wakeWordActive: true });
      expect(s.agentShouldSpeak).toBe(true);
    });
  });
});
