import { describe, it, expect } from "vitest";
import {
  isValidE164,
  TerminalStates,
  CallStateSchema,
  ProviderNameSchema,
  NormalizedEventSchema,
  CallRecordSchema,
  VoiceCallEventTypes,
} from "../../voicecall/types";

describe("Voice Call Types", () => {
  describe("isValidE164", () => {
    it("should accept valid E.164 numbers", () => {
      expect(isValidE164("+15550001234")).toBe(true);
      expect(isValidE164("+442071234567")).toBe(true);
      expect(isValidE164("+8618012345678")).toBe(true);
    });

    it("should reject invalid numbers", () => {
      expect(isValidE164("5550001234")).toBe(false);
      expect(isValidE164("+0550001234")).toBe(false); // Can't start with 0
      expect(isValidE164("")).toBe(false);
      expect(isValidE164("+1")).toBe(false); // Too short
      expect(isValidE164("not-a-number")).toBe(false);
    });
  });

  describe("ProviderNameSchema", () => {
    it("should accept valid provider names", () => {
      expect(ProviderNameSchema.parse("twilio")).toBe("twilio");
      expect(ProviderNameSchema.parse("mock")).toBe("mock");
    });

    it("should reject invalid provider names", () => {
      expect(() => ProviderNameSchema.parse("invalid")).toThrow();
      expect(() => ProviderNameSchema.parse("telnyx")).toThrow();
      expect(() => ProviderNameSchema.parse("plivo")).toThrow();
    });
  });

  describe("CallStateSchema", () => {
    it("should accept all valid states", () => {
      const states = [
        "initiated", "ringing", "answered", "active", "speaking", "listening",
        "completed", "hangup-user", "hangup-bot", "timeout", "error",
        "failed", "no-answer", "busy", "voicemail",
      ];

      for (const state of states) {
        expect(CallStateSchema.parse(state)).toBe(state);
      }
    });

    it("should reject invalid states", () => {
      expect(() => CallStateSchema.parse("invalid")).toThrow();
    });
  });

  describe("TerminalStates", () => {
    it("should contain all terminal states", () => {
      expect(TerminalStates.has("completed")).toBe(true);
      expect(TerminalStates.has("hangup-user")).toBe(true);
      expect(TerminalStates.has("hangup-bot")).toBe(true);
      expect(TerminalStates.has("timeout")).toBe(true);
      expect(TerminalStates.has("error")).toBe(true);
      expect(TerminalStates.has("failed")).toBe(true);
      expect(TerminalStates.has("no-answer")).toBe(true);
      expect(TerminalStates.has("busy")).toBe(true);
      expect(TerminalStates.has("voicemail")).toBe(true);
    });

    it("should not contain non-terminal states", () => {
      expect(TerminalStates.has("initiated")).toBe(false);
      expect(TerminalStates.has("ringing")).toBe(false);
      expect(TerminalStates.has("answered")).toBe(false);
      expect(TerminalStates.has("active")).toBe(false);
      expect(TerminalStates.has("speaking")).toBe(false);
      expect(TerminalStates.has("listening")).toBe(false);
    });
  });

  describe("NormalizedEventSchema", () => {
    it("should parse call.initiated event", () => {
      const event = {
        id: "evt-1",
        callId: "call-1",
        type: "call.initiated",
        timestamp: Date.now(),
      };
      expect(() => NormalizedEventSchema.parse(event)).not.toThrow();
    });

    it("should parse call.speech event", () => {
      const event = {
        id: "evt-1",
        callId: "call-1",
        type: "call.speech",
        transcript: "Hello",
        isFinal: true,
        confidence: 0.95,
        timestamp: Date.now(),
      };
      expect(() => NormalizedEventSchema.parse(event)).not.toThrow();
    });

    it("should parse call.ended event", () => {
      const event = {
        id: "evt-1",
        callId: "call-1",
        type: "call.ended",
        reason: "completed",
        timestamp: Date.now(),
      };
      expect(() => NormalizedEventSchema.parse(event)).not.toThrow();
    });

    it("should reject event with missing required fields", () => {
      const event = {
        type: "call.initiated",
        timestamp: Date.now(),
      };
      expect(() => NormalizedEventSchema.parse(event)).toThrow();
    });
  });

  describe("CallRecordSchema", () => {
    it("should parse a valid call record", () => {
      const record = {
        callId: "call-1",
        provider: "twilio",
        direction: "outbound",
        state: "initiated",
        from: "+15550001234",
        to: "+15559998888",
        startedAt: Date.now(),
        transcript: [],
        processedEventIds: [],
      };
      expect(() => CallRecordSchema.parse(record)).not.toThrow();
    });
  });

  describe("VoiceCallEventTypes", () => {
    it("should have all expected event types", () => {
      expect(VoiceCallEventTypes.CALL_INITIATED).toBe("VOICE_CALL_INITIATED");
      expect(VoiceCallEventTypes.CALL_ENDED).toBe("VOICE_CALL_ENDED");
      expect(VoiceCallEventTypes.CALL_SPEECH).toBe("VOICE_CALL_SPEECH");
      expect(VoiceCallEventTypes.SERVICE_STARTED).toBe("VOICE_CALL_SERVICE_STARTED");
      expect(VoiceCallEventTypes.SERVICE_STOPPED).toBe("VOICE_CALL_SERVICE_STOPPED");
    });
  });
});
