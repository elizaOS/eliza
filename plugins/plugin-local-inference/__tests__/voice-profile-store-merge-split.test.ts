/**
 * Tests for VoiceProfileStore.mergeProfiles + splitProfile (the cluster
 * management operations behind the /api/voice/profiles merge/split routes).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  VoiceProfileStore,
  type VoiceProfileAudioRef,
} from "../src/services/voice/profile-store";
import { WESPEAKER_RESNET34_LM_INT8_MODEL_ID } from "../src/services/voice/speaker/encoder";

const MODEL = WESPEAKER_RESNET34_LM_INT8_MODEL_ID;

let tmpRoot: string;
let store: VoiceProfileStore;

function unit(values: number[]): Float32Array {
  let sumSq = 0;
  for (const v of values) sumSq += v * v;
  const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 1;
  return new Float32Array(values.map((v) => v * inv));
}

function ref(id: string, durationMs = 1000): VoiceProfileAudioRef {
  return {
    sampleId: id,
    wavSha256: `sha-${id}`,
    durationMs,
    recordedAt: new Date().toISOString(),
  };
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "voice-merge-split-"));
  store = new VoiceProfileStore({ rootDir: tmpRoot });
  await store.init();
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("VoiceProfileStore.mergeProfiles", () => {
  it("merges source into target: summed counts, union audio, source deleted", async () => {
    const target = await store.createProfile({
      centroid: unit([1, 0, 0, 0]),
      embeddingModel: MODEL,
      confidence: 0.6,
      durationMs: 2000,
      audioRef: ref("t1"),
      metadata: { label: "Target" },
    });
    const source = await store.createProfile({
      centroid: unit([0, 1, 0, 0]),
      embeddingModel: MODEL,
      confidence: 0.4,
      durationMs: 1000,
      audioRef: ref("s1"),
      entityId: "ent_src",
    });

    const merged = await store.mergeProfiles({
      sourceId: source.profileId,
      targetId: target.profileId,
    });

    expect(merged).not.toBeNull();
    expect(merged?.sampleCount).toBe(2);
    expect(merged?.totalDurationMs).toBe(3000);
    // Unbound target inherits source's entity.
    expect(merged?.entityId).toBe("ent_src");
    expect(merged?.metadata?.label).toBe("Target");
    expect(merged?.audioRefs?.map((r) => r.sampleId).sort()).toEqual(["s1", "t1"]);
    // Centroid stays L2-normalized.
    const norm = Math.sqrt(
      (merged?.centroid ?? []).reduce((s, v) => s + v * v, 0),
    );
    expect(norm).toBeCloseTo(1, 5);
    // Source is gone.
    expect(await store.get(source.profileId)).toBeNull();
  });

  it("refuses to merge two differently-bound entities without override", async () => {
    const target = await store.createProfile({
      centroid: unit([1, 0, 0, 0]),
      embeddingModel: MODEL,
      confidence: 0.6,
      durationMs: 2000,
      entityId: "ent_a",
    });
    const source = await store.createProfile({
      centroid: unit([0, 1, 0, 0]),
      embeddingModel: MODEL,
      confidence: 0.4,
      durationMs: 1000,
      entityId: "ent_b",
    });
    await expect(
      store.mergeProfiles({
        sourceId: source.profileId,
        targetId: target.profileId,
      }),
    ).rejects.toThrow(/entity conflict/);
    // With override it proceeds, keeping the target's binding.
    const merged = await store.mergeProfiles({
      sourceId: source.profileId,
      targetId: target.profileId,
      allowEntityOverwrite: true,
    });
    expect(merged?.entityId).toBe("ent_a");
  });
});

describe("VoiceProfileStore.splitProfile", () => {
  it("moves named samples into a new unbound profile", async () => {
    const profile = await store.createProfile({
      centroid: unit([1, 1, 0, 0]),
      embeddingModel: MODEL,
      confidence: 0.7,
      durationMs: 1000,
      audioRef: ref("a", 1000),
      entityId: "ent_x",
    });
    await store.refine({
      profileId: profile.profileId,
      embedding: unit([1, 1, 0, 0]),
      durationMs: 1000,
      confidence: 0.7,
      audioRef: ref("b", 1000),
    });
    await store.refine({
      profileId: profile.profileId,
      embedding: unit([1, 1, 0, 0]),
      durationMs: 1000,
      confidence: 0.7,
      audioRef: ref("c", 1000),
    });

    const result = await store.splitProfile({
      profileId: profile.profileId,
      sampleIds: ["b", "c"],
    });
    expect(result).not.toBeNull();
    const { original, split } = result!;

    expect(split.profileId).not.toBe(original.profileId);
    expect(split.entityId).toBeNull();
    expect(split.metadata?.splitFrom).toBe(profile.profileId);
    expect(split.audioRefs?.map((r) => r.sampleId).sort()).toEqual(["b", "c"]);
    expect(original.audioRefs?.map((r) => r.sampleId)).toEqual(["a"]);
    // Both are persisted + listed.
    const ids = (await store.list()).map((r) => r.profileId).sort();
    expect(ids).toContain(original.profileId);
    expect(ids).toContain(split.profileId);
  });

  it("throws when no sampleIds match", async () => {
    const profile = await store.createProfile({
      centroid: unit([1, 0, 0, 0]),
      embeddingModel: MODEL,
      confidence: 0.5,
      durationMs: 1000,
      audioRef: ref("a"),
    });
    await expect(
      store.splitProfile({ profileId: profile.profileId, sampleIds: ["zzz"] }),
    ).rejects.toThrow(/no matching sampleIds/);
  });
});
