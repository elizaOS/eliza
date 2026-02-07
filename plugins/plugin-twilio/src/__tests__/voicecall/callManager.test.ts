import { describe, it, expect, vi, beforeEach } from "vitest";
import { CallManager } from "../../voicecall/client";
import type { VoiceCallSettings } from "../../voicecall/environment";
import type { NormalizedEvent } from "../../voicecall/types";

function createTestSettings(overrides?: Partial<VoiceCallSettings>): VoiceCallSettings {
  return {
    enabled: true,
    provider: "twilio",
    fromNumber: "+15550001234",
    inboundPolicy: "disabled",
    allowFrom: [],
    outbound: {
      defaultMode: "notify",
      notifyHangupDelaySec: 3,
    },
    maxDurationSeconds: 300,
    silenceTimeoutMs: 800,
    transcriptTimeoutMs: 5000,
    ringTimeoutMs: 30000,
    maxConcurrentCalls: 2,
    serve: {
      port: 3334,
      bind: "127.0.0.1",
      path: "/voice/webhook",
    },
    streaming: {
      enabled: false,
      sttProvider: "openai-realtime",
      sttModel: "gpt-5-transcribe",
      silenceDurationMs: 800,
      vadThreshold: 0.5,
      streamPath: "/voice/stream",
    },
    skipSignatureVerification: true,
    ...overrides,
  };
}

describe("CallManager", () => {
  let manager: CallManager;
  let settings: VoiceCallSettings;

  beforeEach(() => {
    settings = createTestSettings();
    manager = new CallManager(settings);
    manager.initialize("https://example.com/voice/webhook");
  });

  describe("createOutboundCall", () => {
    it("should create an outbound call with a UUID", () => {
      const { callId, record } = manager.createOutboundCall("+15559998888");

      expect(callId).toBeDefined();
      expect(callId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(record.direction).toBe("outbound");
      expect(record.state).toBe("initiated");
      expect(record.from).toBe("+15550001234");
      expect(record.to).toBe("+15559998888");
      expect(record.transcript).toEqual([]);
    });

    it("should store the call in active calls", () => {
      const { callId } = manager.createOutboundCall("+15559998888");
      const call = manager.getCall(callId);

      expect(call).toBeDefined();
      expect(call?.callId).toBe(callId);
    });

    it("should set mode from options", () => {
      const { record } = manager.createOutboundCall("+15559998888", {
        mode: "conversation",
        message: "Hello!",
      });

      expect(record.metadata?.mode).toBe("conversation");
      expect(record.metadata?.initialMessage).toBe("Hello!");
    });
  });

  describe("getActiveCalls", () => {
    it("should return all active calls", () => {
      manager.createOutboundCall("+15559998881");
      manager.createOutboundCall("+15559998882");

      const activeCalls = manager.getActiveCalls();
      expect(activeCalls).toHaveLength(2);
    });

    it("should return empty array when no calls", () => {
      expect(manager.getActiveCalls()).toEqual([]);
    });
  });

  describe("isAtMaxConcurrentCalls", () => {
    it("should return false when below limit", () => {
      manager.createOutboundCall("+15559998888");
      expect(manager.isAtMaxConcurrentCalls()).toBe(false);
    });

    it("should return true when at limit", () => {
      manager.createOutboundCall("+15559998881");
      manager.createOutboundCall("+15559998882");
      expect(manager.isAtMaxConcurrentCalls()).toBe(true);
    });
  });

  describe("updateProviderCallId", () => {
    it("should update the provider call ID", () => {
      const { callId } = manager.createOutboundCall("+15559998888");
      manager.updateProviderCallId(callId, "CA_PROVIDER_123");

      const call = manager.getCall(callId);
      expect(call?.providerCallId).toBe("CA_PROVIDER_123");
    });

    it("should allow lookup by provider call ID", () => {
      const { callId } = manager.createOutboundCall("+15559998888");
      manager.updateProviderCallId(callId, "CA_PROVIDER_123");

      const call = manager.getCallByProviderCallId("CA_PROVIDER_123");
      expect(call?.callId).toBe(callId);
    });
  });

  describe("updateState", () => {
    it("should transition through normal call states", () => {
      const { callId } = manager.createOutboundCall("+15559998888");

      manager.updateState(callId, "ringing");
      expect(manager.getCall(callId)?.state).toBe("ringing");

      manager.updateState(callId, "answered");
      expect(manager.getCall(callId)?.state).toBe("answered");

      manager.updateState(callId, "active");
      expect(manager.getCall(callId)?.state).toBe("active");
    });

    it("should not go backwards in state", () => {
      const { callId } = manager.createOutboundCall("+15559998888");

      manager.updateState(callId, "answered");
      manager.updateState(callId, "ringing"); // Should not go back

      expect(manager.getCall(callId)?.state).toBe("answered");
    });

    it("should allow transitions between speaking and listening", () => {
      const { callId } = manager.createOutboundCall("+15559998888");

      manager.updateState(callId, "answered");
      manager.updateState(callId, "speaking");
      expect(manager.getCall(callId)?.state).toBe("speaking");

      manager.updateState(callId, "listening");
      expect(manager.getCall(callId)?.state).toBe("listening");

      manager.updateState(callId, "speaking");
      expect(manager.getCall(callId)?.state).toBe("speaking");
    });
  });

  describe("addTranscriptEntry", () => {
    it("should add transcript entries", () => {
      const { callId } = manager.createOutboundCall("+15559998888");

      manager.addTranscriptEntry(callId, "bot", "Hello there!");
      manager.addTranscriptEntry(callId, "user", "Hi back!");

      const call = manager.getCall(callId);
      expect(call?.transcript).toHaveLength(2);
      expect(call?.transcript[0].speaker).toBe("bot");
      expect(call?.transcript[0].text).toBe("Hello there!");
      expect(call?.transcript[1].speaker).toBe("user");
    });
  });

  describe("markEnded", () => {
    it("should remove call from active calls and add to history", () => {
      const { callId } = manager.createOutboundCall("+15559998888");

      manager.markEnded(callId, "completed");

      expect(manager.getCall(callId)).toBeUndefined();
      expect(manager.getCallHistory()).toHaveLength(1);
      expect(manager.getCallHistory()[0].endReason).toBe("completed");
    });

    it("should set endedAt timestamp", () => {
      const { callId } = manager.createOutboundCall("+15559998888");
      const beforeEnd = Date.now();

      manager.markEnded(callId, "hangup-bot");

      const history = manager.getCallHistory();
      expect(history[0].endedAt).toBeDefined();
      expect(history[0].endedAt!).toBeGreaterThanOrEqual(beforeEnd);
    });
  });

  describe("markAnswered", () => {
    it("should set answeredAt and transition to answered", () => {
      const { callId } = manager.createOutboundCall("+15559998888");
      manager.updateState(callId, "ringing");

      manager.markAnswered(callId);

      const call = manager.getCall(callId);
      expect(call?.state).toBe("answered");
      expect(call?.answeredAt).toBeDefined();
    });
  });

  describe("processEvent", () => {
    it("should process call.initiated event", () => {
      const { callId } = manager.createOutboundCall("+15559998888");

      const event: NormalizedEvent = {
        id: "evt-1",
        callId,
        type: "call.initiated",
        timestamp: Date.now(),
      };

      const result = manager.processEvent(event);
      expect(result).toBeDefined();
      expect(result?.state).toBe("initiated");
    });

    it("should process call.answered event", () => {
      const { callId } = manager.createOutboundCall("+15559998888");

      const event: NormalizedEvent = {
        id: "evt-1",
        callId,
        type: "call.answered",
        timestamp: Date.now(),
      };

      const result = manager.processEvent(event);
      expect(result?.state).toBe("answered");
      expect(result?.answeredAt).toBeDefined();
    });

    it("should process call.speech event and add transcript", () => {
      const { callId } = manager.createOutboundCall("+15559998888");

      const event: NormalizedEvent = {
        id: "evt-1",
        callId,
        type: "call.speech",
        transcript: "Hello, I am calling about...",
        isFinal: true,
        timestamp: Date.now(),
      };

      const result = manager.processEvent(event);
      expect(result?.transcript).toHaveLength(1);
      expect(result?.transcript[0].text).toBe("Hello, I am calling about...");
    });

    it("should process call.ended event and move to history", () => {
      const { callId } = manager.createOutboundCall("+15559998888");

      const event: NormalizedEvent = {
        id: "evt-1",
        callId,
        type: "call.ended",
        reason: "completed",
        timestamp: Date.now(),
      };

      manager.processEvent(event);

      expect(manager.getCall(callId)).toBeUndefined();
      expect(manager.getCallHistory()).toHaveLength(1);
    });

    it("should deduplicate events by ID", () => {
      const { callId } = manager.createOutboundCall("+15559998888");

      const event: NormalizedEvent = {
        id: "evt-1",
        callId,
        type: "call.ringing",
        timestamp: Date.now(),
      };

      manager.processEvent(event);
      const secondResult = manager.processEvent(event); // Same event ID

      expect(secondResult).toBeUndefined();
    });

    it("should handle inbound calls when policy allows", () => {
      const openManager = new CallManager(
        createTestSettings({ inboundPolicy: "open" }),
      );
      openManager.initialize("https://example.com/voice/webhook");

      const event: NormalizedEvent = {
        id: "evt-1",
        callId: "unknown-call",
        providerCallId: "CA_INBOUND_123",
        type: "call.ringing",
        direction: "inbound",
        from: "+15559998888",
        to: "+15550001234",
        timestamp: Date.now(),
      };

      const result = openManager.processEvent(event);
      expect(result).toBeDefined();
      expect(result?.direction).toBe("inbound");
    });

    it("should reject inbound calls when policy is disabled", () => {
      const event: NormalizedEvent = {
        id: "evt-1",
        callId: "unknown-call",
        providerCallId: "CA_INBOUND_123",
        type: "call.ringing",
        direction: "inbound",
        from: "+15559998888",
        to: "+15550001234",
        timestamp: Date.now(),
      };

      const result = manager.processEvent(event);
      expect(result).toBeUndefined();
    });
  });

  describe("getCallHistory", () => {
    it("should return history in reverse chronological order", () => {
      const { callId: id1 } = manager.createOutboundCall("+15559998881");
      const { callId: id2 } = manager.createOutboundCall("+15559998882");

      manager.markEnded(id1, "completed");
      manager.markEnded(id2, "completed");

      const history = manager.getCallHistory();
      expect(history).toHaveLength(2);
      expect(history[0].to).toBe("+15559998882"); // Most recent first
    });

    it("should respect limit parameter", () => {
      for (let i = 0; i < 5; i++) {
        const { callId } = manager.createOutboundCall(`+1555999888${i}`);
        manager.markEnded(callId, "completed");
      }

      const history = manager.getCallHistory(3);
      expect(history).toHaveLength(3);
    });
  });
});
