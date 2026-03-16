import { __voiceChatInternals } from "@elizaos/app-core/hooks";
import { describe, expect, it } from "vitest";

const {
  remainderAfter,
  queueableSpeechPrefix,
  resolveEffectiveVoiceConfig,
  toSpeakableText,
} = __voiceChatInternals;

describe("useVoiceChat streaming text helpers", () => {
  it("returns only unseen suffix text when remainder grows", () => {
    expect(remainderAfter("alpha beta gamma", "alpha beta")).toBe("gamma");
  });

  it("does not replay full text when prefix matching fails", () => {
    expect(
      remainderAfter("canonical final response", "first streamed sentence."),
    ).toBe("");
  });

  it("queues only complete sentences before the final chunk", () => {
    expect(
      queueableSpeechPrefix(
        "second sentence done. third sentence still streaming",
        false,
      ),
    ).toBe("second sentence done.");
  });

  it("flushes all remaining text on the final chunk", () => {
    expect(
      queueableSpeechPrefix(
        "second sentence done. third sentence still streaming",
        true,
      ),
    ).toBe("second sentence done. third sentence still streaming");
  });

  it("falls back to a chunk for long text without punctuation", () => {
    const longText = [
      "this stream has no punctuation and keeps going with useful words",
      "so the speaker should not remain silent forever while waiting",
      "for a sentence boundary that never arrives during generation",
    ].join(" ");

    const queued = queueableSpeechPrefix(longText, false);
    expect(queued.length).toBeGreaterThan(80);
    expect(queued.length).toBeLessThan(longText.length);
  });

  it("defaults to ElevenLabs cloud config when Cloud auth is present", () => {
    expect(
      resolveEffectiveVoiceConfig(null, {
        cloudConnected: true,
      }),
    ).toEqual({
      provider: "elevenlabs",
      mode: "cloud",
      elevenlabs: {
        voiceId: "EXAVITQu4vr4xnSDxMaL",
        modelId: "eleven_flash_v2_5",
        stability: 0.5,
        similarityBoost: 0.75,
        speed: 1,
      },
    });
  });

  it("keeps explicit non-ElevenLabs providers intact", () => {
    expect(
      resolveEffectiveVoiceConfig(
        {
          provider: "edge",
          edge: { voice: "en-US-AriaNeural" },
        },
        { cloudConnected: true },
      ),
    ).toEqual({
      provider: "edge",
      edge: { voice: "en-US-AriaNeural" },
    });
  });

  it("drops parenthetical asides and stage directions from speech", () => {
    expect(
      toSpeakableText(
        "Hello there (with extra context). *curtsies* Visit https://example.com now.",
      ),
    ).toBe("Hello there. Visit now.");
  });

  it("returns empty text when only stage directions remain", () => {
    expect(toSpeakableText("*waves* (quietly) [off mic]")).toBe("");
  });
});
