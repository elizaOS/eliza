/**
 * Unit coverage for Cloud TTS URL/model/header resolution helpers
 * in server-cloud-tts.ts.
 *
 * Tests retry decision predicates, voice ID resolution and normalization,
 * model normalization, compat header bidirectional mirroring, and candidate URL builders.
 */

import { describe, expect, it } from "vitest";
import {
  ELIZA_CLOUD_TTS_MAX_TEXT_CHARS,
  mirrorCompatHeaders,
  normalizeElizaCloudTtsModelId,
  resolveCloudProxyTtsModel,
  resolveElizaCloudTtsVoiceId,
  shouldRetryCloudTtsUpstream,
} from "./server-cloud-tts.js";

describe("server-cloud-tts", () => {
  describe("constants and retry heuristics", () => {
    it("defines ELIZA_CLOUD_TTS_MAX_TEXT_CHARS as 5000", () => {
      expect(ELIZA_CLOUD_TTS_MAX_TEXT_CHARS).toBe(5000);
    });

    it("identifies retryable HTTP status codes (404 fallback, 502, 503)", () => {
      expect(shouldRetryCloudTtsUpstream(404)).toBe(true);
      expect(shouldRetryCloudTtsUpstream(502)).toBe(true);
      expect(shouldRetryCloudTtsUpstream(503)).toBe(true);

      expect(shouldRetryCloudTtsUpstream(200)).toBe(false);
      expect(shouldRetryCloudTtsUpstream(400)).toBe(false);
      expect(shouldRetryCloudTtsUpstream(401)).toBe(false);
      expect(shouldRetryCloudTtsUpstream(500)).toBe(false);
    });
  });

  describe("resolveElizaCloudTtsVoiceId", () => {
    it("returns requested valid voiceId when specified", () => {
      expect(resolveElizaCloudTtsVoiceId("custom-voice-123")).toBe(
        "custom-voice-123",
      );
      expect(resolveElizaCloudTtsVoiceId("  custom-voice-123  ")).toBe(
        "custom-voice-123",
      );
    });

    it("falls back to env.ELIZAOS_CLOUD_TTS_VOICE when body voiceId is omitted", () => {
      expect(
        resolveElizaCloudTtsVoiceId("", {
          ELIZAOS_CLOUD_TTS_VOICE: "env-voice-456",
        }),
      ).toBe("env-voice-456");
    });

    it("maps OpenAI-style voice aliases to default voice", () => {
      expect(resolveElizaCloudTtsVoiceId("alloy")).toBe("EXAVITQu4vr4xnSDxMaL");
      expect(resolveElizaCloudTtsVoiceId("echo")).toBe("EXAVITQu4vr4xnSDxMaL");
      expect(resolveElizaCloudTtsVoiceId("shimmer")).toBe(
        "EXAVITQu4vr4xnSDxMaL",
      );
    });

    it("maps Azure/Edge Neural voices to default voice", () => {
      expect(resolveElizaCloudTtsVoiceId("en-US-JennyNeural")).toBe(
        "EXAVITQu4vr4xnSDxMaL",
      );
    });

    it("defaults to canonical EXAVITQu4vr4xnSDxMaL voice when unconfigured", () => {
      expect(resolveElizaCloudTtsVoiceId(undefined, {})).toBe(
        "EXAVITQu4vr4xnSDxMaL",
      );
      expect(resolveElizaCloudTtsVoiceId("", {})).toBe("EXAVITQu4vr4xnSDxMaL");
    });
  });

  describe("normalizeElizaCloudTtsModelId & resolveCloudProxyTtsModel", () => {
    it("maps OpenAI models and tts-1 to eleven_flash_v2_5", () => {
      expect(normalizeElizaCloudTtsModelId("gpt-4o-audio")).toBe(
        "eleven_flash_v2_5",
      );
      expect(normalizeElizaCloudTtsModelId("tts-1-hd")).toBe(
        "eleven_flash_v2_5",
      );
      expect(normalizeElizaCloudTtsModelId("mini-tts-v1")).toBe(
        "eleven_flash_v2_5",
      );
    });

    it("preserves valid ElevenLabs model IDs", () => {
      expect(normalizeElizaCloudTtsModelId("eleven_multilingual_v2")).toBe(
        "eleven_multilingual_v2",
      );
      expect(normalizeElizaCloudTtsModelId("eleven_turbo_v2")).toBe(
        "eleven_turbo_v2",
      );
      expect(normalizeElizaCloudTtsModelId("eleven_flash_v2_5")).toBe(
        "eleven_flash_v2_5",
      );
    });

    it("defaults to eleven_flash_v2_5 when model ID is empty or whitespace", () => {
      expect(normalizeElizaCloudTtsModelId("")).toBe("eleven_flash_v2_5");
      expect(normalizeElizaCloudTtsModelId("   ")).toBe("eleven_flash_v2_5");
    });

    it("resolveCloudProxyTtsModel resolves model from body or env", () => {
      expect(resolveCloudProxyTtsModel("eleven_turbo_v2", {})).toBe(
        "eleven_turbo_v2",
      );
      expect(
        resolveCloudProxyTtsModel("", {
          ELIZAOS_CLOUD_TTS_MODEL: "eleven_multilingual_v2",
        }),
      ).toBe("eleven_multilingual_v2");
    });
  });

  describe("mirrorCompatHeaders", () => {
    it("mirrors x-elizaos-* headers to x-eliza-* aliases", () => {
      const req: {
        headers: Record<string, string | string[] | undefined>;
      } = {
        headers: {
          "x-elizaos-token": "auth-token-123",
        },
      };

      mirrorCompatHeaders(req);
      expect(req.headers["x-eliza-token"]).toBe("auth-token-123");
    });

    it("mirrors x-eliza-* headers to x-elizaos-* aliases", () => {
      const req: {
        headers: Record<string, string | string[] | undefined>;
      } = {
        headers: {
          "x-eliza-client-id": "client-abc",
        },
      };

      mirrorCompatHeaders(req);
      expect(req.headers["x-elizaos-client-id"]).toBe("client-abc");
    });
  });
});
