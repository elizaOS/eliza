/**
 * Unit tests for InMemoryVoiceProfileStore: upsert/get/list/delete roundtrips,
 * cosine-similarity search sorted descending with the limit honored, and a
 * 200-profile scale case asserting top-k results stay ordered by similarity.
 */
import { describe, expect, it } from "vitest";
import { InMemoryVoiceProfileStore } from "../store.ts";
import type { VoiceProfile } from "../types.ts";

function makeProfile(
  id: string,
  vector: number[],
  owner = false,
): VoiceProfile {
  return {
    id,
    owner,
    embeddingModel: "ecapa-voxceleb",
    embeddings: [
      { vectorPreview: vector, modelId: "ecapa-voxceleb", createdAt: 1 },
    ],
    quality: { samples: 5, seconds: 10, noiseFloor: -50, lastUpdatedAt: 1 },
    consent: "explicit",
  };
}

describe("InMemoryVoiceProfileStore", () => {
  it("upsert and get roundtrip", async () => {
    const s = new InMemoryVoiceProfileStore();
    await s.upsert(makeProfile("a", [1, 0, 0]));
    const got = await s.get("a");
    expect(got?.id).toBe("a");
  });

  it("get returns null for missing id", async () => {
    const s = new InMemoryVoiceProfileStore();
    expect(await s.get("missing")).toBeNull();
  });

  it("list returns all profiles", async () => {
    const s = new InMemoryVoiceProfileStore();
    await s.upsert(makeProfile("a", [1, 0]));
    await s.upsert(makeProfile("b", [0, 1]));
    expect((await s.list()).length).toBe(2);
  });

  it("delete removes by id", async () => {
    const s = new InMemoryVoiceProfileStore();
    await s.upsert(makeProfile("a", [1, 0]));
    await s.delete("a");
    expect(await s.get("a")).toBeNull();
  });

  it("search sorts by similarity descending", async () => {
    const s = new InMemoryVoiceProfileStore();
    await s.upsert(makeProfile("near", [1, 0, 0]));
    await s.upsert(makeProfile("mid", [0.7, 0.7, 0]));
    await s.upsert(makeProfile("far", [0, 0, 1]));
    const hits = await s.search([1, 0, 0], 3);
    expect(hits.map((h) => h.profile.id)).toEqual(["near", "mid", "far"]);
    expect(hits[0]?.similarity ?? 0).toBeGreaterThan(hits[1]?.similarity ?? 0);
  });

  it("search respects limit", async () => {
    const s = new InMemoryVoiceProfileStore();
    for (let i = 0; i < 10; i++) {
      await s.upsert(makeProfile(`p${i}`, [Math.cos(i), Math.sin(i)]));
    }
    const hits = await s.search([1, 0], 3);
    expect(hits.length).toBe(3);
  });

  it("scales to 200 profiles with top-k sorted similarities", async () => {
    const s = new InMemoryVoiceProfileStore();
    for (let i = 0; i < 200; i++) {
      const theta = (i / 200) * Math.PI * 2;
      await s.upsert(makeProfile(`p${i}`, [Math.cos(theta), Math.sin(theta)]));
    }
    const hits = await s.search([1, 0], 5);
    expect(hits.length).toBe(5);
    for (let i = 1; i < hits.length; i++) {
      const prev = hits[i - 1]?.similarity ?? 0;
      const cur = hits[i]?.similarity ?? 0;
      expect(prev).toBeGreaterThanOrEqual(cur);
    }
  });
});

describe("InMemoryVoiceProfileStore edge branches", () => {
  it("search on an empty store returns no hits", async () => {
    const s = new InMemoryVoiceProfileStore();
    expect(await s.search([1, 0], 5)).toEqual([]);
  });

  it("skips profiles whose embeddings list is empty", async () => {
    const s = new InMemoryVoiceProfileStore();
    const hollow: VoiceProfile = {
      ...makeProfile("hollow", [1, 0]),
      embeddings: [],
    };
    await s.upsert(hollow);
    await s.upsert(makeProfile("voiced", [1, 0]));
    const hits = await s.search([1, 0], 10);
    expect(hits.map((h) => h.profile.id)).toEqual(["voiced"]);
  });

  it("scores a zero-magnitude stored vector as similarity 0 instead of dropping it", async () => {
    const s = new InMemoryVoiceProfileStore();
    await s.upsert(makeProfile("flat", [0, 0]));
    const hits = await s.search([1, 0], 10);
    expect(hits.map((h) => h.profile.id)).toEqual(["flat"]);
    expect(hits[0]?.similarity).toBe(0);
  });

  it("scores an empty query vector as similarity 0 against stored profiles", async () => {
    const s = new InMemoryVoiceProfileStore();
    await s.upsert(makeProfile("a", [1, 0]));
    const hits = await s.search([], 10);
    expect(hits.length).toBe(1);
    expect(hits[0]?.similarity).toBe(0);
  });

  it("compares only the overlapping prefix when vector lengths differ", async () => {
    const s = new InMemoryVoiceProfileStore();
    await s.upsert(makeProfile("short", [1]));
    const hits = await s.search([1, 0, 0], 10);
    expect(hits[0]?.profile.id).toBe("short");
    expect(hits[0]?.similarity).toBe(1);
  });

  it("uses the best similarity across all stored embeddings of a profile", async () => {
    const s = new InMemoryVoiceProfileStore();
    const mixed: VoiceProfile = {
      ...makeProfile("mixed", [0, 1]),
      embeddings: [
        { vectorPreview: [0, 1], modelId: "ecapa-voxceleb", createdAt: 1 },
        { vectorPreview: [1, 0], modelId: "ecapa-voxceleb", createdAt: 2 },
        { vectorPreview: [-1, 0], modelId: "ecapa-voxceleb", createdAt: 3 },
      ],
    };
    await s.upsert(mixed);
    const hits = await s.search([1, 0], 10);
    expect(hits.length).toBe(1);
    expect(hits[0]?.similarity).toBe(1);
  });

  it("defaults the limit to 10 hits when omitted", async () => {
    const s = new InMemoryVoiceProfileStore();
    for (let i = 0; i < 14; i++) {
      await s.upsert(makeProfile(`p${i}`, [Math.cos(i), Math.sin(i)]));
    }
    const hits = await s.search([1, 0]);
    expect(hits.length).toBe(10);
  });

  it("negative similarities sort below zero-similarity hits", async () => {
    const s = new InMemoryVoiceProfileStore();
    await s.upsert(makeProfile("opposite", [-1, 0]));
    await s.upsert(makeProfile("orthogonal", [0, 1]));
    const hits = await s.search([1, 0], 10);
    expect(hits.map((h) => h.profile.id)).toEqual(["orthogonal", "opposite"]);
    expect(hits[1]?.similarity).toBe(-1);
  });

  it("ties keep insertion order across equal similarities", async () => {
    const s = new InMemoryVoiceProfileStore();
    await s.upsert(makeProfile("first", [1, 0]));
    await s.upsert(makeProfile("second", [1, 0]));
    const hits = await s.search([2, 0], 10);
    expect(hits.map((h) => h.profile.id)).toEqual(["first", "second"]);
    expect(hits[0]?.similarity).toBe(1);
    expect(hits[1]?.similarity).toBe(1);
  });

  it("upsert replaces the profile stored under an existing id", async () => {
    const s = new InMemoryVoiceProfileStore();
    await s.upsert(makeProfile("a", [1, 0]));
    const replacement: VoiceProfile = {
      ...makeProfile("a", [0, 1]),
      consent: "unknown",
    };
    await s.upsert(replacement);
    expect((await s.list()).length).toBe(1);
    const got = await s.get("a");
    expect(got?.consent).toBe("unknown");
  });

  it("delete of a missing id resolves without side effects", async () => {
    const s = new InMemoryVoiceProfileStore();
    await s.upsert(makeProfile("kept", [1, 0]));
    await expect(s.delete("ghost")).resolves.toBeUndefined();
    expect((await s.list()).map((p) => p.id)).toEqual(["kept"]);
  });
});
