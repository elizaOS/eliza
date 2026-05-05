import { describe, expect, it } from "vitest";
import { VoiceAffectService } from "./voice-affect.js";

const service = new VoiceAffectService();

function baseInput(
  overrides: Partial<Parameters<VoiceAffectService["analyze"]>[0]> = {},
) {
  return {
    utteranceId: "utt-1",
    messageId: "msg-1",
    capturedAt: "2026-05-03T12:00:00.000Z",
    consent: "ephemeral_only" as const,
    retention: { kind: "ephemeral" as const },
    features: {
      pauseDurationsMs: [180, 240],
      falseStartCount: 0,
      speechRateWpm: 135,
      pitchVarianceHz: 12,
      volumeVarianceDb: 3,
      transcriptUncertaintyTokenCount: 0,
      transcriptTokenCount: 20,
    },
    ...overrides,
  };
}

describe("VoiceAffectService", () => {
  it("requires consent before durable persistence", () => {
    const durable = service.buildDurableRecord(
      baseInput({
        consent: "none",
        retention: {
          kind: "ttl",
          expiresAt: "2026-05-03T12:30:00.000Z",
        },
      }),
    );

    expect(durable.status).toBe("withheld");
    if (durable.status === "withheld") {
      expect(durable.reasons).toContain("voice_affect_consent_not_granted");
      expect(durable.reasons).toContain(
        "durable_storage_requires_persist_features_consent",
      );
    }
  });

  it("rejects raw audio payloads at the feature boundary", () => {
    expect(() =>
      service.analyze(
        baseInput({
          features: {
            rawAudio: "base64",
            pauseDurationsMs: [100],
          },
        }),
      ),
    ).toThrow("raw audio key");
  });

  it("detects hesitance from long pauses and false starts with a confidence cap", () => {
    const analysis = service.analyze(
      baseInput({
        features: {
          pauseDurationsMs: [900, 1700, 2300],
          falseStartCount: 3,
          speechRateWpm: 92,
          transcriptUncertaintyTokenCount: 5,
          transcriptTokenCount: 24,
        },
      }),
    );

    expect(analysis.labels).toContain("hesitant");
    expect(analysis.labels).toContain("uncertain");
    expect(analysis.scores.hesitance).toBeGreaterThan(0.7);
    expect(analysis.confidence).toBeLessThanOrEqual(0.8);
  });

  it("marks transcript-only analysis as degraded and caps confidence", () => {
    const analysis = service.analyze(
      baseInput({
        features: {
          transcriptUncertaintyTokenCount: 3,
          transcriptTokenCount: 12,
        },
      }),
    );

    expect(analysis.degradedReasons).toContain("transcript_only");
    expect(analysis.confidence).toBeLessThanOrEqual(0.55);
  });

  it("detects urgency from fast speech and high acoustic variance", () => {
    const analysis = service.analyze(
      baseInput({
        features: {
          speechRateWpm: 220,
          volumeVarianceDb: 11,
          pitchVarianceHz: 78,
          transcriptUncertaintyTokenCount: 0,
          transcriptTokenCount: 32,
        },
      }),
    );

    expect(analysis.labels).toContain("urgent");
    expect(analysis.scores.urgency).toBeGreaterThan(0.55);
  });

  it("reduces confidence when affect signals contradict each other", () => {
    const analysis = service.analyze(
      baseInput({
        features: {
          pauseDurationsMs: [2400],
          falseStartCount: 3,
          speechRateWpm: 230,
          pitchVarianceHz: 90,
          volumeVarianceDb: 14,
          transcriptUncertaintyTokenCount: 3,
          transcriptTokenCount: 15,
        },
      }),
    );

    expect(analysis.labels).toEqual(
      expect.arrayContaining(["hesitant", "urgent"]),
    );
    expect(analysis.degradedReasons).toContain("mixed_affect_signals");
    expect(analysis.confidence).toBeLessThan(0.8);
  });

  it("bounds every score to the zero-to-one range", () => {
    const analysis = service.analyze(
      baseInput({
        features: {
          pauseDurationsMs: [30_000],
          falseStartCount: 99,
          speechRateWpm: 500,
          pitchVarianceHz: 500,
          volumeVarianceDb: 100,
          transcriptUncertaintyTokenCount: 100,
          transcriptTokenCount: 1,
        },
      }),
    );

    expect(Object.values(analysis.scores).every((score) => score >= 0)).toBe(
      true,
    );
    expect(Object.values(analysis.scores).every((score) => score <= 1)).toBe(
      true,
    );
  });

  it("requires utterance and message identifiers", () => {
    expect(() => service.analyze(baseInput({ utteranceId: "" }))).toThrow(
      "utteranceId is required",
    );
    expect(() => service.analyze(baseInput({ messageId: " " }))).toThrow(
      "messageId is required",
    );
  });

  it("withholds durable records after retention expiry", () => {
    const durable = service.buildDurableRecord(
      baseInput({
        consent: "persist_features",
        retention: {
          kind: "ttl",
          expiresAt: "2026-05-03T11:59:59.000Z",
        },
      }),
    );

    expect(durable.status).toBe("withheld");
    if (durable.status === "withheld") {
      expect(durable.reasons).toContain("retention_expired");
    }
  });

  it("creates a persistable durable record only with consent, ttl, and policy allowance", () => {
    const durable = service.buildDurableRecord(
      baseInput({
        consent: "persist_features",
        retention: {
          kind: "ttl",
          expiresAt: "2026-05-03T12:30:00.000Z",
        },
        policyDecision: {
          effect: "allow",
          reason: "owner_enabled_voice_affect",
        },
      }),
    );

    expect(durable.status).toBe("persistable");
    if (durable.status === "persistable") {
      expect(durable.event.retention.expiresAt).toBe(
        "2026-05-03T12:30:00.000Z",
      );
    }
  });

  it("omits feature payloads from planner slices", () => {
    const analysis = service.analyze(baseInput());
    const slice = service.toPlannerSlice(analysis);

    expect(slice).toMatchObject({
      utteranceId: "utt-1",
      messageId: "msg-1",
      scores: analysis.scores,
    });
    expect("features" in slice).toBe(false);
    expect("pauseDurationsMs" in slice).toBe(false);
  });
});
