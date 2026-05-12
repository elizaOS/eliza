import { describe, expect, it } from "vitest";
import {
  attributeVoiceImprintObservations,
  cosineSimilarity,
  matchVoiceImprint,
  normalizeVoiceEmbedding,
  updateVoiceImprintCentroid,
  type VoiceImprintProfile,
  voiceSpeakerFromImprintMatch,
} from "./speaker-imprint";

describe("speaker-imprint", () => {
  it("normalizes embeddings and computes cosine similarity", () => {
    const normalized = normalizeVoiceEmbedding([3, 4]);
    expect(normalized[0]).toBeCloseTo(0.6, 6);
    expect(normalized[1]).toBeCloseTo(0.8, 6);
    expect(cosineSimilarity([2, 0], [4, 0])).toBeCloseTo(1, 6);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 6);
  });

  it("matches the nearest compatible voice imprint above threshold", () => {
    const profiles: VoiceImprintProfile[] = [
      {
        id: "cluster-a",
        label: "Owner",
        centroidEmbedding: [1, 0],
        embeddingModel: "eliza-voice-embed-v1",
        confidence: 0.9,
        entityId: "entity-owner",
      },
      {
        id: "cluster-b",
        label: "Guest",
        centroidEmbedding: [0, 1],
        embeddingModel: "eliza-voice-embed-v1",
        confidence: 0.9,
      },
    ];

    const match = matchVoiceImprint({
      embedding: [0.98, 0.05],
      embeddingModel: "eliza-voice-embed-v1",
      profiles,
      threshold: 0.8,
    });

    expect(match?.profile.id).toBe("cluster-a");
    expect(match?.similarity).toBeGreaterThan(0.99);
    if (!match) throw new Error("expected voice imprint match");
    const speaker = voiceSpeakerFromImprintMatch({
      match,
      observationId: "obs-1",
      source: { kind: "local_mic", deviceId: "mic-1" },
    });
    expect(speaker.entityId).toBe("entity-owner");
    expect(speaker.imprintClusterId).toBe("cluster-a");
    expect(speaker.imprintObservationId).toBe("obs-1");
    expect(speaker.source?.kind).toBe("local_mic");
  });

  it("does not match across embedding-model or dimension mismatches", () => {
    const profiles: VoiceImprintProfile[] = [
      {
        id: "cluster-a",
        centroidEmbedding: [1, 0],
        embeddingModel: "other-model",
      },
      {
        id: "cluster-b",
        centroidEmbedding: [1, 0, 0],
        embeddingModel: "eliza-voice-embed-v1",
      },
    ];

    expect(
      matchVoiceImprint({
        embedding: [1, 0],
        embeddingModel: "eliza-voice-embed-v1",
        profiles,
      }),
    ).toBeNull();
  });

  it("updates a centroid with weighted observations", () => {
    const first = updateVoiceImprintCentroid({
      observationEmbedding: [10, 0],
      observationConfidence: 0.8,
    });
    expect(first.centroidEmbedding).toEqual([1, 0]);
    expect(first.sampleCount).toBe(1);
    expect(first.confidence).toBeCloseTo(0.8, 6);

    const second = updateVoiceImprintCentroid({
      centroidEmbedding: first.centroidEmbedding,
      sampleCount: first.sampleCount,
      confidence: first.confidence,
      observationEmbedding: [0, 10],
      observationConfidence: 0.5,
    });
    expect(second.sampleCount).toBe(2);
    expect(second.centroidEmbedding[0]).toBeGreaterThan(
      second.centroidEmbedding[1],
    );
    expect(second.confidence).toBeCloseTo(0.65, 6);
  });

  it("attributes diarized observation embeddings without granting synthesis or identity authority", () => {
    const profiles: VoiceImprintProfile[] = [
      {
        id: "cluster-owner",
        label: "Owner",
        displayName: "Owner",
        entityId: "entity-owner",
        centroidEmbedding: [1, 0],
        embeddingModel: "eliza-voice-embed-v1",
        confidence: 0.9,
      },
      {
        id: "cluster-guest",
        label: "Guest",
        entityId: "entity-guest",
        centroidEmbedding: [0, 1],
        embeddingModel: "eliza-voice-embed-v1",
        confidence: 0.8,
      },
    ];
    const source = {
      kind: "local_mic" as const,
      deviceId: "default-input",
      roomId: "room-1",
    };

    const result = attributeVoiceImprintObservations({
      defaultSource: source,
      profiles,
      threshold: 0.8,
      observations: [
        {
          id: "obs-owner-1",
          segmentId: "seg-owner-1",
          text: "I am the owner",
          startMs: 0,
          endMs: 1200,
          embedding: [0.99, 0.02],
          embeddingModel: "eliza-voice-embed-v1",
        },
        {
          id: "obs-guest-1",
          segmentId: "seg-guest-1",
          text: "and I am a guest",
          startMs: 1300,
          endMs: 2100,
          embedding: [0.02, 0.99],
          embeddingModel: "eliza-voice-embed-v1",
        },
      ],
    });

    expect(result.summary).toMatchObject({
      totalObservations: 2,
      matchedObservations: 2,
      unmatchedObservations: 0,
    });
    expect(result.primarySpeaker?.entityId).toBe("entity-owner");
    expect(result.segments.map((segment) => segment.speaker?.entityId)).toEqual(
      ["entity-owner", "entity-guest"],
    );
    expect(result.segments[0].metadata).toMatchObject({
      attributionOnly: true,
      imprintClusterId: "cluster-owner",
      imprintObservationId: "obs-owner-1",
      entityId: "entity-owner",
    });
  });
});
