import { describe, expect, it } from "vitest";
import { type VoiceAffectService, voiceAffectService } from "./voice-affect";

function baseInput(
  features: Record<string, unknown> = {},
): Parameters<VoiceAffectService["analyze"]>[0] {
  return {
    utteranceId: "utterance-1",
    messageId: "message-1",
    capturedAt: "2026-08-25T00:00:00.000Z",
    consent: "ephemeral_only",
    retention: { kind: "ttl", expiresAt: "2026-09-01T00:00:00.000Z" },
    features,
  };
}

describe("voice affect raw audio guard", () => {
  it.each([
    ["Audio", "different casing"],
    ["RAW_AUDIO", "upper snake case"],
    ["raw_audio", "snake case"],
    ["audio_data", "snake case variant"],
    ["audioData", "camelCase variant"],
    ["base64Audio", "base64 camelCase"],
    ["audioBlob", "blob camelCase"],
    ["pcm", "pcm"],
  ])("rejects raw audio smuggled under key %s (%s)", (key) => {
    expect(() =>
      voiceAffectService.analyze(
        baseInput({ [key]: "UE9TVC1TSEFSRUQgTUVUQURBVEE=" }),
      ),
    ).toThrow(/raw audio/i);
  });

  it("accepts legitimate non-audio affect features", () => {
    const result = voiceAffectService.analyze(
      baseInput({
        pauseDurationsMs: [120, 340],
        speechRateWpm: 140,
        transcriptTokenCount: 200,
        transcriptUncertaintyTokenCount: 10,
        pitchVarianceHz: 3.5,
      }),
    );
    expect(result.eventType).toBe("voice_affect_event");
    expect(result.scores.hesitance).toBeGreaterThanOrEqual(0);
    expect(result.scores.hesitance).toBeLessThanOrEqual(1);
    expect(result.withheldReasons).toEqual([]);
  });

  it("still rejects the canonical raw audio keys", () => {
    for (const key of ["audio", "buffer", "samples", "waveform"]) {
      expect(() =>
        voiceAffectService.analyze(baseInput({ [key]: "x" })),
      ).toThrow(/raw audio/i);
    }
  });
});

describe("voice affect durable record gate", () => {
  it("withholds durable storage unless persist_features consent is granted", () => {
    const result = voiceAffectService.buildDurableRecord(baseInput());
    expect(result.status).toBe("withheld");
    expect(result.reasons).toContain(
      "durable_storage_requires_persist_features_consent",
    );
  });

  it("withholds durable storage when retention is not ttl", () => {
    const result = voiceAffectService.buildDurableRecord({
      ...baseInput(),
      consent: "persist_features",
      retention: { kind: "ephemeral" },
    });
    expect(result.status).toBe("withheld");
    expect(result.reasons).toContain("durable_storage_requires_ttl_retention");
  });

  it("withholds when the ttl retention has already expired", () => {
    const expired = voiceAffectService.buildDurableRecord({
      ...baseInput(),
      consent: "persist_features",
      retention: {
        kind: "ttl",
        expiresAt: "2026-08-01T00:00:00.000Z",
      },
    });
    expect(expired.status).toBe("withheld");
    expect(expired.reasons).toContain("retention_expired");
  });

  it("persists when consent and a future ttl are present", () => {
    const result = voiceAffectService.buildDurableRecord({
      ...baseInput({ pauseDurationsMs: [100] }),
      consent: "persist_features",
    });
    expect(result.status).toBe("persistable");
    if (result.status === "persistable") {
      expect(result.event.retention.kind).toBe("ttl");
      expect(result.event.retention.expiresAt).toBe("2026-09-01T00:00:00.000Z");
    }
  });
});
