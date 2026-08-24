/**
 * Unit tests for the voice-profiles public barrel (`../index.ts`): every test
 * drives the real re-exported implementations through the module consumers
 * actually import — MOCK_DIARIZATION_PIPELINE, NAIVE_NICKNAME_EVALUATOR,
 * scoreOwnerConfidence, InMemoryChallengeService, and
 * InMemoryVoiceProfileStore. Deterministic harness: fixed clocks, fixed
 * vectors, no mocks and no network.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { VoiceProfile } from "../index.ts";
import {
  InMemoryChallengeService,
  InMemoryVoiceProfileStore,
  MOCK_DIARIZATION_PIPELINE,
  NAIVE_NICKNAME_EVALUATOR,
  scoreOwnerConfidence,
} from "../index.ts";

function makeProfile(
  id: string,
  vectors: number[][],
  owner = false,
): VoiceProfile {
  return {
    id,
    owner,
    embeddingModel: "ecapa-voxceleb",
    embeddings: vectors.map((vectorPreview) => ({
      vectorPreview,
      modelId: "ecapa-voxceleb",
      createdAt: 1,
    })),
    quality: { samples: 5, seconds: 10, noiseFloor: -50, lastUpdatedAt: 1 },
    consent: "explicit",
  };
}

describe("MOCK_DIARIZATION_PIPELINE via barrel", () => {
  it("returns no segments for an empty audio ref", async () => {
    await expect(MOCK_DIARIZATION_PIPELINE.diarize("")).resolves.toEqual([]);
  });

  it("returns two fixed speaker segments for a non-empty ref", async () => {
    const segments = await MOCK_DIARIZATION_PIPELINE.diarize("clip.wav");
    expect(segments).toEqual([
      {
        startMs: 0,
        endMs: 1000,
        profileId: "mock-speaker-a",
        confidence: 0.8,
      },
      {
        startMs: 1000,
        endMs: 2000,
        profileId: "mock-speaker-b",
        confidence: 0.7,
      },
    ]);
  });
});

describe("NAIVE_NICKNAME_EVALUATOR via barrel", () => {
  it("returns no proposals for an empty transcript", async () => {
    await expect(NAIVE_NICKNAME_EVALUATOR.evaluate([])).resolves.toEqual([]);
  });

  it("returns no proposals when no entry self-names", async () => {
    const proposals = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "t1", text: "the weather is nice today" },
    ]);
    expect(proposals).toEqual([]);
  });

  it('extracts "call me" with pattern confidence and trims punctuation', async () => {
    const proposals = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "t1", text: "honestly you can call me Ace." },
    ]);
    expect(proposals).toEqual([
      {
        nickname: "Ace",
        subject: "owner",
        confidence: 0.85,
        supportingTranscriptId: "t1",
      },
    ]);
  });

  it("extracts each self-naming pattern with its own confidence", async () => {
    const proposals = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "a", text: "my name is Sam" },
      { id: "b", text: "I go by Rob" },
    ]);
    expect(proposals.map((p) => p.nickname)).toEqual(["Sam", "Rob"]);
    expect(proposals.map((p) => p.confidence)).toEqual([0.95, 0.8]);
    expect(proposals.map((p) => p.supportingTranscriptId)).toEqual(["a", "b"]);
  });

  it("requires a capitalized nickname token", async () => {
    const proposals = await NAIVE_NICKNAME_EVALUATOR.evaluate([
      { id: "t1", text: "call me ace please" },
    ]);
    expect(proposals).toEqual([]);
  });
});

describe("scoreOwnerConfidence via barrel", () => {
  it("scores zero with empty reasons when every signal is off", () => {
    const result = scoreOwnerConfidence({
      voiceSimilarityToOwnerProfile: 0,
      deviceTrustLevel: "low",
      recentlyAuthenticated: false,
      contextExpectsOwner: false,
      challengeRecentlyPassed: false,
    });
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([]);
  });

  it("sums every signal and clamps the total to 1", () => {
    const result = scoreOwnerConfidence({
      voiceSimilarityToOwnerProfile: 1,
      deviceTrustLevel: "high",
      recentlyAuthenticated: true,
      contextExpectsOwner: true,
      challengeRecentlyPassed: true,
    });
    expect(result.score).toBe(1);
    expect(result.reasons).toEqual([
      "challenge-recently-passed",
      "recently-authenticated",
      "voice-similarity:1.00",
      "device-trust:high",
      "context-expects-owner",
    ]);
  });

  it("clamps out-of-range voice similarity before scoring", () => {
    const negative = scoreOwnerConfidence({
      voiceSimilarityToOwnerProfile: -0.5,
      deviceTrustLevel: "low",
      recentlyAuthenticated: false,
      contextExpectsOwner: false,
      challengeRecentlyPassed: false,
    });
    expect(negative.score).toBe(0);
    expect(negative.reasons).toEqual([]);

    const overOne = scoreOwnerConfidence({
      voiceSimilarityToOwnerProfile: 2,
      deviceTrustLevel: "low",
      recentlyAuthenticated: false,
      contextExpectsOwner: false,
      challengeRecentlyPassed: false,
    });
    expect(overOne.reasons).toEqual(["voice-similarity:1.00"]);
    expect(overOne.score).toBeCloseTo(0.25);
  });

  it("weights device trust by level and skips low entirely", () => {
    const medium = scoreOwnerConfidence({
      voiceSimilarityToOwnerProfile: 0,
      deviceTrustLevel: "medium",
      recentlyAuthenticated: false,
      contextExpectsOwner: false,
      challengeRecentlyPassed: false,
    });
    expect(medium.score).toBeCloseTo(0.1);
    expect(medium.reasons).toEqual(["device-trust:medium"]);

    const low = scoreOwnerConfidence({
      voiceSimilarityToOwnerProfile: 0,
      deviceTrustLevel: "low",
      recentlyAuthenticated: false,
      contextExpectsOwner: false,
      challengeRecentlyPassed: false,
    });
    expect(low.reasons).toEqual([]);
  });

  it("scales partial voice similarity proportionally", () => {
    const result = scoreOwnerConfidence({
      voiceSimilarityToOwnerProfile: 0.5,
      deviceTrustLevel: "low",
      recentlyAuthenticated: false,
      contextExpectsOwner: false,
      challengeRecentlyPassed: false,
    });
    expect(result.score).toBeCloseTo(0.125);
    expect(result.reasons).toEqual(["voice-similarity:0.50"]);
  });
});

describe("InMemoryChallengeService via barrel", () => {
  it("mints a challenge stamped with the injected clock and ttl", async () => {
    let clock = 1_000_000;
    const service = new InMemoryChallengeService({
      now: () => clock,
      ttlMs: 1000,
    });
    const challenge = await service.issue("say cheese");
    expect(challenge.prompt).toBe("say cheese");
    expect(challenge.createdAt).toBe(1_000_000);
    expect(challenge.expiresAt).toBe(1_001_000);
    expect(challenge.id.length).toBe(36);
    expect(challenge.expectedAnswerHash).toMatch(/^[0-9a-f]{64}$/);
    clock += 1;
    const second = await service.issue();
    expect(second.createdAt).toBe(1_000_001);
    expect(second.expiresAt - second.createdAt).toBe(1000);
  });

  it("defaults the prompt, ttl, and seeded digest when unconfigured", async () => {
    const service = new InMemoryChallengeService({ now: () => 42 });
    const challenge = await service.issue();
    expect(challenge.prompt).toBe("Confirm your private phrase");
    expect(challenge.createdAt).toBe(42);
    expect(challenge.expiresAt - challenge.createdAt).toBe(5 * 60_000);
    expect(challenge.expectedAnswerHash).toBe(
      createHash("sha256").update(`${challenge.id}:default`).digest("hex"),
    );
  });

  it("verifies the configured answer once and consumes the challenge", async () => {
    const service = new InMemoryChallengeService({
      now: () => 0,
      expectedAnswer: "open sesame",
    });
    const challenge = await service.issue();
    expect(await service.verify(challenge.id, "wrong phrase")).toBe(false);
    expect(await service.verify(challenge.id, "open sesame")).toBe(true);
    expect(await service.verify(challenge.id, "open sesame")).toBe(false);
  });

  it("rejects unknown challenge ids", async () => {
    const service = new InMemoryChallengeService({ now: () => 0 });
    await expect(service.verify("no-such-id", "anything")).resolves.toBe(false);
  });

  it("rejects and retires an expired challenge", async () => {
    let clock = 10_000;
    const service = new InMemoryChallengeService({
      now: () => clock,
      ttlMs: 1000,
      expectedAnswer: "open sesame",
    });
    const challenge = await service.issue();
    clock += 1001;
    expect(await service.verify(challenge.id, "open sesame")).toBe(false);
    expect(await service.verify(challenge.id, "open sesame")).toBe(false);
  });
});

describe("InMemoryVoiceProfileStore via barrel", () => {
  it("upserts, gets, lists, deletes, and tolerates deleting a missing id", async () => {
    const store = new InMemoryVoiceProfileStore();
    await store.upsert(makeProfile("a", [[1, 0]]));
    const got = await store.get("a");
    expect(got?.id).toBe("a");

    await store.upsert(makeProfile("b", [[0, 1]]));
    expect((await store.list()).map((p) => p.id).sort()).toEqual(["a", "b"]);

    await store.upsert(makeProfile("a", [[0.5, 0.5]]));
    expect((await store.list()).length).toBe(2);

    await store.delete("a");
    expect(await store.get("a")).toBeNull();

    await store.delete("never-existed");
    expect(await store.get("never-existed")).toBeNull();
  });

  it("searches an empty store to no hits", async () => {
    const store = new InMemoryVoiceProfileStore();
    expect(await store.search([1, 0])).toEqual([]);
  });

  it("orders hits by descending similarity and caps at the limit", async () => {
    const store = new InMemoryVoiceProfileStore();
    await store.upsert(makeProfile("near", [[1, 0]]));
    await store.upsert(makeProfile("mid", [[0.7, 0.7]]));
    await store.upsert(makeProfile("far", [[0, 1]]));
    const hits = await store.search([1, 0], 2);
    expect(hits.map((h) => h.profile.id)).toEqual(["near", "mid"]);
    expect(hits[0]?.similarity).toBeCloseTo(1);
  });

  it("defaults the limit to 10 when callers omit it", async () => {
    const store = new InMemoryVoiceProfileStore();
    for (let i = 0; i < 12; i++) {
      await store.upsert(makeProfile(`p${i}`, [[Math.cos(i), Math.sin(i)]]));
    }
    const hits = await store.search([1, 0]);
    expect(hits.length).toBe(10);
  });

  it("excludes profiles that carry no embeddings from search", async () => {
    const store = new InMemoryVoiceProfileStore();
    await store.upsert(makeProfile("empty", []));
    await store.upsert(makeProfile("real", [[1, 0]]));
    const hits = await store.search([1, 0]);
    expect(hits.map((h) => h.profile.id)).toEqual(["real"]);
  });

  it("scores a zero-magnitude embedding as similarity 0 instead of dropping it", async () => {
    const store = new InMemoryVoiceProfileStore();
    await store.upsert(makeProfile("flat", [[0, 0]]));
    const hits = await store.search([1, 0]);
    expect(hits.length).toBe(1);
    expect(hits[0]?.profile.id).toBe("flat");
    expect(hits[0]?.similarity).toBe(0);
  });

  it("ranks a profile by its best embedding preview", async () => {
    const store = new InMemoryVoiceProfileStore();
    await store.upsert(
      makeProfile("multi", [
        [0, -1],
        [1, 0],
      ]),
    );
    const hits = await store.search([1, 0]);
    expect(hits.length).toBe(1);
    expect(hits[0]?.similarity).toBeCloseTo(1);
  });
});
