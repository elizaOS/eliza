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
