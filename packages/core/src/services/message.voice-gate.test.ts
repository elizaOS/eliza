import { describe, expect, it } from "vitest";
import {
  voiceTurnSignalConfirmsAgent,
  voiceTurnSignalSuppressesAgent,
} from "./message";

// #9147 — the server-side voice-turn-signal gate (decide/veto over the client's
// VoiceTurnSignalMetadata). These were untested; lock the truth table so the
// suppress/confirm contract can't drift.
describe("server voice-turn-signal gate (#9147)", () => {
  describe("voiceTurnSignalSuppressesAgent", () => {
    it("fails open on a null signal (no signal never silences a turn)", () => {
      expect(voiceTurnSignalSuppressesAgent(null)).toBe(false);
    });
    it("suppresses when the client says the agent should not speak", () => {
      expect(voiceTurnSignalSuppressesAgent({ agentShouldSpeak: false })).toBe(
        true,
      );
    });
    it("suppresses when the next speaker is the user", () => {
      expect(voiceTurnSignalSuppressesAgent({ nextSpeaker: "user" })).toBe(true);
    });
    it("suppresses when end-of-turn reads as the user still talking (<0.4)", () => {
      expect(
        voiceTurnSignalSuppressesAgent({ endOfTurnProbability: 0.3 }),
      ).toBe(true);
    });
    it("does not suppress a clean agent turn", () => {
      expect(
        voiceTurnSignalSuppressesAgent({
          agentShouldSpeak: true,
          nextSpeaker: "agent",
          endOfTurnProbability: 0.9,
        }),
      ).toBe(false);
    });
  });

  describe("voiceTurnSignalConfirmsAgent", () => {
    it("does not confirm a null signal", () => {
      expect(voiceTurnSignalConfirmsAgent(null)).toBe(false);
    });
    it("confirms on an explicit agentShouldSpeak with a non-user next speaker", () => {
      expect(
        voiceTurnSignalConfirmsAgent({
          agentShouldSpeak: true,
          nextSpeaker: "agent",
        }),
      ).toBe(true);
    });
    it("does not confirm when end-of-turn reads as still talking (<0.4)", () => {
      expect(
        voiceTurnSignalConfirmsAgent({
          agentShouldSpeak: true,
          endOfTurnProbability: 0.3,
        }),
      ).toBe(false);
    });
    it("does not confirm when the next speaker is the user", () => {
      expect(
        voiceTurnSignalConfirmsAgent({
          agentShouldSpeak: true,
          nextSpeaker: "user",
        }),
      ).toBe(false);
    });
    it("is conservative: a merely-absent agentShouldSpeak never confirms", () => {
      expect(voiceTurnSignalConfirmsAgent({ nextSpeaker: "agent" })).toBe(false);
    });
  });
});
