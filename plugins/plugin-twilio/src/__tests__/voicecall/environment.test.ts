import { describe, it, expect, vi } from "vitest";
import {
  buildVoiceCallSettings,
  validateProviderConfig,
  type VoiceCallEnvConfig,
} from "../../voicecall/environment";

describe("Voice Call Environment", () => {
  describe("buildVoiceCallSettings", () => {
    it("should build settings with twilio provider", () => {
      const config: VoiceCallEnvConfig = {
        VOICE_CALL_PROVIDER: "twilio",
        VOICE_CALL_FROM_NUMBER: "+15550001234",
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "auth123",
      };

      const settings = buildVoiceCallSettings(config);

      expect(settings.enabled).toBe(true);
      expect(settings.provider).toBe("twilio");
      expect(settings.fromNumber).toBe("+15550001234");
      expect(settings.twilio?.accountSid).toBe("AC123");
      expect(settings.twilio?.authToken).toBe("auth123");
    });

    it("should fall back to TWILIO_PHONE_NUMBER for fromNumber", () => {
      const config: VoiceCallEnvConfig = {
        VOICE_CALL_PROVIDER: "twilio",
        TWILIO_PHONE_NUMBER: "+15550009999",
        TWILIO_ACCOUNT_SID: "AC123",
        TWILIO_AUTH_TOKEN: "auth123",
      };

      const settings = buildVoiceCallSettings(config);
      expect(settings.fromNumber).toBe("+15550009999");
    });

    it("should build settings with mock provider", () => {
      const config: VoiceCallEnvConfig = {
        VOICE_CALL_PROVIDER: "mock",
        VOICE_CALL_FROM_NUMBER: "+15550001234",
      };

      const settings = buildVoiceCallSettings(config);

      expect(settings.provider).toBe("mock");
      expect(settings.twilio).toBeUndefined();
    });

    it("should throw when provider is not set", () => {
      const config: VoiceCallEnvConfig = {
        VOICE_CALL_FROM_NUMBER: "+15550001234",
      };

      expect(() => buildVoiceCallSettings(config)).toThrow(
        "VOICE_CALL_PROVIDER is required",
      );
    });

    it("should set defaults correctly", () => {
      const config: VoiceCallEnvConfig = {
        VOICE_CALL_PROVIDER: "mock",
        VOICE_CALL_FROM_NUMBER: "+15550001234",
      };

      const settings = buildVoiceCallSettings(config);

      expect(settings.maxDurationSeconds).toBe(300);
      expect(settings.maxConcurrentCalls).toBe(1);
      expect(settings.inboundPolicy).toBe("disabled");
      expect(settings.outbound.defaultMode).toBe("notify");
      expect(settings.serve.port).toBe(3334);
      expect(settings.skipSignatureVerification).toBe(false);
    });

    it("should respect custom configuration values", () => {
      const config: VoiceCallEnvConfig = {
        VOICE_CALL_PROVIDER: "mock",
        VOICE_CALL_FROM_NUMBER: "+15550001234",
        VOICE_CALL_MAX_DURATION_SECONDS: 600,
        VOICE_CALL_MAX_CONCURRENT_CALLS: 5,
        VOICE_CALL_INBOUND_POLICY: "open",
        VOICE_CALL_WEBHOOK_PORT: 4000,
        VOICE_CALL_PUBLIC_URL: "https://my-server.com",
      };

      const settings = buildVoiceCallSettings(config);

      expect(settings.maxDurationSeconds).toBe(600);
      expect(settings.maxConcurrentCalls).toBe(5);
      expect(settings.inboundPolicy).toBe("open");
      expect(settings.serve.port).toBe(4000);
      expect(settings.publicUrl).toBe("https://my-server.com");
    });
  });

  describe("validateProviderConfig", () => {
    it("should pass for disabled settings", () => {
      const result = validateProviderConfig({
        enabled: false,
        provider: "twilio",
        fromNumber: "",
        inboundPolicy: "disabled",
        allowFrom: [],
        outbound: { defaultMode: "notify", notifyHangupDelaySec: 3 },
        maxDurationSeconds: 300,
        silenceTimeoutMs: 800,
        transcriptTimeoutMs: 180000,
        ringTimeoutMs: 30000,
        maxConcurrentCalls: 1,
        serve: { port: 3334, bind: "127.0.0.1", path: "/voice/webhook" },
        streaming: {
          enabled: false,
          sttProvider: "openai-realtime",
          sttModel: "gpt-5-transcribe",
          silenceDurationMs: 800,
          vadThreshold: 0.5,
          streamPath: "/voice/stream",
        },
        skipSignatureVerification: false,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should fail when twilio credentials are missing", () => {
      const result = validateProviderConfig({
        enabled: true,
        provider: "twilio",
        fromNumber: "+15550001234",
        inboundPolicy: "disabled",
        allowFrom: [],
        outbound: { defaultMode: "notify", notifyHangupDelaySec: 3 },
        maxDurationSeconds: 300,
        silenceTimeoutMs: 800,
        transcriptTimeoutMs: 180000,
        ringTimeoutMs: 30000,
        maxConcurrentCalls: 1,
        serve: { port: 3334, bind: "127.0.0.1", path: "/voice/webhook" },
        streaming: {
          enabled: false,
          sttProvider: "openai-realtime",
          sttModel: "gpt-5-transcribe",
          silenceDurationMs: 800,
          vadThreshold: 0.5,
          streamPath: "/voice/stream",
        },
        skipSignatureVerification: false,
        twilio: {},
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        "TWILIO_ACCOUNT_SID is required for Twilio provider",
      );
      expect(result.errors).toContain(
        "TWILIO_AUTH_TOKEN is required for Twilio provider",
      );
    });

    it("should fail when fromNumber is missing", () => {
      const result = validateProviderConfig({
        enabled: true,
        provider: "twilio",
        fromNumber: "",
        inboundPolicy: "disabled",
        allowFrom: [],
        outbound: { defaultMode: "notify", notifyHangupDelaySec: 3 },
        maxDurationSeconds: 300,
        silenceTimeoutMs: 800,
        transcriptTimeoutMs: 180000,
        ringTimeoutMs: 30000,
        maxConcurrentCalls: 1,
        serve: { port: 3334, bind: "127.0.0.1", path: "/voice/webhook" },
        streaming: {
          enabled: false,
          sttProvider: "openai-realtime",
          sttModel: "gpt-5-transcribe",
          silenceDurationMs: 800,
          vadThreshold: 0.5,
          streamPath: "/voice/stream",
        },
        skipSignatureVerification: false,
        twilio: { accountSid: "AC123", authToken: "auth123" },
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toContain("VOICE_CALL_FROM_NUMBER is required");
    });
  });
});
