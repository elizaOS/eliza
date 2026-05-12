import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  matchVoiceImprint,
  normalizeVoiceEmbedding,
  updateVoiceImprintCentroid,
  voiceSpeakerFromImprintMatch,
  type VoiceImprintProfile,
} from "./speaker-imprint";

describe("speaker-imprint", () => {
  it("normalizes embeddings and computes cosine similarity", () => {
    expect(normalizeVoiceEmbedding([3, 4])).toEqual([0.6, 0.8]);
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
    const speaker = voiceSpeakerFromImprintMatch({
      match: match!,
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
    expect(second.centroidEmbedding[0]).toBeGreaterThan(second.centroidEmbedding[1]);
    expect(second.confidence).toBeCloseTo(0.65, 6);
  });
});
