/**
 * Unit tests for `VoiceProfileStore` — the content-addressed voice
 * profile store backing I2's speaker-ID system.
 *
 * Covers:
 *   - Welford running-mean / variance correctness (single + multi sample).
 *   - Outlier rejection (≥4σ on majority of dims).
 *   - Hot LRU eviction (cap = `hotCacheSize`).
 *   - Cold-disk persistence + reload.
 *   - Cold-disk eviction respects `entityId !== null` (bound profiles
 *     never auto-deleted) and a sample-count / confidence floor.
 *   - `findBestMatch` filters by `embeddingModel` + `embeddingDim`.
 *   - `beginMatch` returns the same result as `findBestMatch` once the
 *     deferred embedding resolves.
 *   - `bindEntity` / `unbindEntity` round-trip.
 *   - `deleteProfile` refuses to drop a bound profile without
 *     `allowBoundEntity:true`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	isOutlier,
	VoiceProfileStore,
	type VoiceProfileRecord,
	welfordUpdate,
	welfordVariance,
} from "../src/services/voice/profile-store";

const DIM = 4;
const MODEL = "wespeaker-resnet34-lm-int8";

function unit(values: number[]): Float32Array {
	const out = new Float32Array(values.length);
	let sumSq = 0;
	for (const v of values) sumSq += v * v;
	const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 1;
	for (let i = 0; i < values.length; i += 1) out[i] = values[i] * inv;
	return out;
}

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(path.join(tmpdir(), "vp-store-"));
});
afterEach(() => {
	rmSync(tmpRoot, { recursive: true, force: true });
});

async function newStore(opts: Partial<{ hotCacheSize: number; coldDiskMax: number }> = {}) {
	const store = new VoiceProfileStore({ rootDir: tmpRoot, ...opts });
	await store.init();
	return store;
}

describe("welfordUpdate", () => {
	it("single sample puts mean=observation, M2=0", () => {
		const obs = [1, 2, 3];
		const r = welfordUpdate({ count: 0, mean: [], m2: [], observation: obs });
		expect(r.count).toBe(1);
		expect(r.mean).toEqual([1, 2, 3]);
		expect(r.m2).toEqual([0, 0, 0]);
	});

	it("matches the naive variance formula after N updates", () => {
		const samples = [
			[1, 2],
			[3, 4],
			[5, 6],
			[7, 8],
		];
		let mean: number[] = [];
		let m2: number[] = [];
		let count = 0;
		for (const s of samples) {
			const r = welfordUpdate({ count, mean, m2, observation: s });
			mean = r.mean;
			m2 = r.m2;
			count = r.count;
		}
		// Naive: mean = column-mean; variance = sum((x-mean)^2)/(n-1)
		const naiveMean = [
			(1 + 3 + 5 + 7) / 4,
			(2 + 4 + 6 + 8) / 4,
		];
		expect(mean[0]).toBeCloseTo(naiveMean[0], 10);
		expect(mean[1]).toBeCloseTo(naiveMean[1], 10);
		const variance = welfordVariance(m2, count);
		const naiveVar = [
			(Math.pow(1 - 4, 2) + Math.pow(3 - 4, 2) + Math.pow(5 - 4, 2) + Math.pow(7 - 4, 2)) / 3,
			(Math.pow(2 - 5, 2) + Math.pow(4 - 5, 2) + Math.pow(6 - 5, 2) + Math.pow(8 - 5, 2)) / 3,
		];
		expect(variance[0]).toBeCloseTo(naiveVar[0], 10);
		expect(variance[1]).toBeCloseTo(naiveVar[1], 10);
	});

	it("throws on dim mismatch", () => {
		expect(() =>
			welfordUpdate({
				count: 1,
				mean: [0, 0, 0],
				m2: [0, 0],
				observation: [1, 1, 1],
			}),
		).toThrow(/dim mismatch/);
	});
});

describe("isOutlier", () => {
	it("flags a sample > sigma on majority of dims", () => {
		const centroid = [0, 0, 0, 0];
		const variance = [1, 1, 1, 1];
		const observation = [10, 10, 10, 0]; // 3/4 dims at 10σ
		expect(isOutlier({ centroid, variance, observation, sigmaThreshold: 4 })).toBe(true);
	});

	it("passes a sample close to the centroid", () => {
		const centroid = [0, 0, 0, 0];
		const variance = [1, 1, 1, 1];
		const observation = [0.1, -0.1, 0.0, 0.1];
		expect(isOutlier({ centroid, variance, observation, sigmaThreshold: 4 })).toBe(false);
	});

	it("ignores dims with zero variance (no info)", () => {
		const centroid = [0, 0];
		const variance = [0, 0]; // no samples — nothing to test against
		expect(isOutlier({ centroid, variance, observation: [100, 100] })).toBe(false);
	});
});

describe("VoiceProfileStore — basic round-trip", () => {
	it("createProfile + get + list", async () => {
		const store = await newStore();
		const centroid = unit([1, 0, 0, 0]);
		const rec = await store.createProfile({
			centroid,
			embeddingModel: MODEL,
			confidence: 0.8,
			durationMs: 1500,
		});
		expect(rec.profileId).toMatch(/^vp_[0-9a-f]{32}$/);
		expect(rec.embeddingDim).toBe(DIM);
		expect(rec.entityId).toBeNull();

		const loaded = await store.get(rec.profileId);
		expect(loaded?.profileId).toBe(rec.profileId);
		const listed = await store.list();
		expect(listed.map((r) => r.profileId)).toContain(rec.profileId);
	});

	it("bindEntity / unbindEntity round-trip", async () => {
		const store = await newStore();
		const rec = await store.createProfile({
			centroid: unit([0, 1, 0, 0]),
			embeddingModel: MODEL,
			confidence: 0.5,
			durationMs: 1500,
		});
		const bound = await store.bindEntity({
			profileId: rec.profileId,
			entityId: "ent_jill",
			label: "wife",
		});
		expect(bound?.entityId).toBe("ent_jill");
		expect(bound?.metadata?.label).toBe("wife");

		const unbound = await store.unbindEntity(rec.profileId);
		expect(unbound?.entityId).toBeNull();
	});

	it("deleteProfile refuses bound profiles unless allowBoundEntity", async () => {
		const store = await newStore();
		const rec = await store.createProfile({
			centroid: unit([0, 0, 1, 0]),
			embeddingModel: MODEL,
			confidence: 0.5,
			durationMs: 1500,
		});
		await store.bindEntity({ profileId: rec.profileId, entityId: "ent_shaw" });
		await expect(store.deleteProfile({ profileId: rec.profileId })).rejects.toThrow(
			/bound to entity/,
		);
		const ok = await store.deleteProfile({
			profileId: rec.profileId,
			allowBoundEntity: true,
		});
		expect(ok).toBe(true);
		expect(await store.get(rec.profileId)).toBeNull();
	});
});

describe("VoiceProfileStore — refinement (Welford)", () => {
	it("refine updates centroid + sampleCount + variance", async () => {
		const store = await newStore();
		const rec = await store.createProfile({
			centroid: unit([1, 0, 0, 0]),
			embeddingModel: MODEL,
			confidence: 0.5,
			durationMs: 1000,
		});
		const refined = await store.refine({
			profileId: rec.profileId,
			embedding: unit([0.9, 0.1, 0, 0]),
			durationMs: 500,
			confidence: 0.7,
		});
		expect(refined?.sampleCount).toBe(2);
		// The centroid should drift toward the observation but stay
		// unit-norm (cosine-friendly).
		let sumSq = 0;
		for (const v of refined!.centroid) sumSq += v * v;
		expect(sumSq).toBeCloseTo(1, 6);
		// And variance is bumped off zero on at least one dim.
		const anyNonZero = refined!.variance.some((v) => v > 1e-9);
		expect(anyNonZero).toBe(true);
	});

	it("refine rejects gross outliers (after warm-up)", async () => {
		const store = await newStore();
		// Spread samples across multiple dims so variance is non-zero on
		// most of the embedding, and the centroid drifts toward (.5,.5,.5,.5).
		const seed = unit([0.5, 0.5, 0.5, 0.5]);
		const rec = await store.createProfile({
			centroid: seed,
			embeddingModel: MODEL,
			confidence: 0.8,
			durationMs: 1000,
		});
		// Warm-up: fold three near-centroid samples; per-dim spread is ~0.05.
		const warmUp = [
			[0.55, 0.5, 0.5, 0.45],
			[0.5, 0.55, 0.45, 0.5],
			[0.45, 0.5, 0.5, 0.55],
		];
		for (const v of warmUp) {
			await store.refine({
				profileId: rec.profileId,
				embedding: unit(v),
				durationMs: 500,
				confidence: 0.8,
			});
		}
		const before = await store.get(rec.profileId);
		// Outlier: orthogonal axis — every dim flips sign at ≥10σ given
		// the warm-up spread.
		await store.refine({
			profileId: rec.profileId,
			embedding: unit([-1, -1, -1, -1]),
			durationMs: 500,
			confidence: 0.8,
		});
		const after = await store.get(rec.profileId);
		// Sample count stays the same because the outlier was rejected.
		expect(after?.sampleCount).toBe(before?.sampleCount);
	});

	it("dropOutliers=false folds the sample regardless", async () => {
		const store = await newStore();
		const seed = unit([0.5, 0.5, 0.5, 0.5]);
		const rec = await store.createProfile({
			centroid: seed,
			embeddingModel: MODEL,
			confidence: 0.8,
			durationMs: 1000,
		});
		for (const v of [
			[0.55, 0.5, 0.5, 0.45],
			[0.5, 0.55, 0.45, 0.5],
			[0.45, 0.5, 0.5, 0.55],
		]) {
			await store.refine({
				profileId: rec.profileId,
				embedding: unit(v),
				durationMs: 500,
				confidence: 0.8,
			});
		}
		const before = await store.get(rec.profileId);
		await store.refine({
			profileId: rec.profileId,
			embedding: unit([-1, -1, -1, -1]),
			durationMs: 500,
			confidence: 0.8,
			dropOutliers: false,
		});
		const after = await store.get(rec.profileId);
		expect(after?.sampleCount).toBe((before?.sampleCount ?? 0) + 1);
	});
});

describe("VoiceProfileStore — match contract", () => {
	it("findBestMatch finds the best of N profiles above threshold", async () => {
		const store = await newStore({ hotCacheSize: 4 });
		await store.createProfile({
			centroid: unit([1, 0, 0, 0]),
			embeddingModel: MODEL,
			confidence: 0.9,
			durationMs: 1500,
		});
		await store.createProfile({
			centroid: unit([0, 1, 0, 0]),
			embeddingModel: MODEL,
			confidence: 0.9,
			durationMs: 1500,
		});
		const m = await store.findBestMatch({
			embedding: unit([0.95, 0.05, 0, 0]),
			embeddingModel: MODEL,
		});
		expect(m).not.toBeNull();
		expect(m?.profile.centroidEmbedding[0]).toBeGreaterThan(0.9);
	});

	it("findBestMatch ignores profiles from a different embedding model", async () => {
		const store = await newStore();
		await store.createProfile({
			centroid: unit([1, 0, 0, 0]),
			embeddingModel: "other-encoder",
			confidence: 0.9,
			durationMs: 1500,
		});
		const m = await store.findBestMatch({
			embedding: unit([1, 0, 0, 0]),
			embeddingModel: MODEL,
		});
		expect(m).toBeNull();
	});

	it("findBestMatch returns null below match threshold", async () => {
		const store = await newStore();
		await store.createProfile({
			centroid: unit([1, 0, 0, 0]),
			embeddingModel: MODEL,
			confidence: 0.9,
			durationMs: 1500,
		});
		// Orthogonal embedding => cosine ≈ 0 ≪ 0.78 default threshold.
		const m = await store.findBestMatch({
			embedding: unit([0, 1, 0, 0]),
			embeddingModel: MODEL,
		});
		expect(m).toBeNull();
	});

	it("beginMatch resolves with the deferred embedding's best match", async () => {
		const store = await newStore();
		await store.createProfile({
			centroid: unit([1, 0, 0, 0]),
			embeddingModel: MODEL,
			confidence: 0.9,
			durationMs: 1500,
		});
		const handle = store.beginMatch({
			embed: async () => ({
				embedding: unit([0.99, 0.01, 0, 0]),
				embeddingModel: MODEL,
			}),
		});
		const m = await handle.result;
		expect(m).not.toBeNull();
		expect(handle.current()).toEqual(m);
	});

	it("beginMatch resolves to null when cancelled", async () => {
		const store = await newStore();
		const handle = store.beginMatch({
			embed: async () => {
				await new Promise((r) => setTimeout(r, 5));
				return { embedding: unit([1, 0, 0, 0]), embeddingModel: MODEL };
			},
		});
		handle.cancel();
		const m = await handle.result;
		expect(m).toBeNull();
	});
});

describe("VoiceProfileStore — LRU + persistence", () => {
	it("hot cache evicts LRU when over hotCacheSize", async () => {
		const store = await newStore({ hotCacheSize: 2 });
		const a = await store.createProfile({
			centroid: unit([1, 0, 0, 0]),
			embeddingModel: MODEL,
			confidence: 0.5,
			durationMs: 1500,
		});
		const b = await store.createProfile({
			centroid: unit([0, 1, 0, 0]),
			embeddingModel: MODEL,
			confidence: 0.5,
			durationMs: 1500,
		});
		const c = await store.createProfile({
			centroid: unit([0, 0, 1, 0]),
			embeddingModel: MODEL,
			confidence: 0.5,
			durationMs: 1500,
		});
		// Hot cache holds 2. Profile A is LRU and should have been
		// dropped from memory, but persisted to disk and still resolvable.
		const loaded = await store.get(a.profileId);
		expect(loaded?.profileId).toBe(a.profileId);
		// b + c are still resolvable too.
		expect((await store.get(b.profileId))?.profileId).toBe(b.profileId);
		expect((await store.get(c.profileId))?.profileId).toBe(c.profileId);
	});

	it("survives close + reload from disk", async () => {
		const first = await newStore({ hotCacheSize: 4 });
		const rec = await first.createProfile({
			centroid: unit([0, 0, 0, 1]),
			embeddingModel: MODEL,
			confidence: 0.6,
			durationMs: 1500,
		});
		// New store on the same dir.
		const second = await newStore({ hotCacheSize: 4 });
		const loaded = await second.get(rec.profileId);
		expect(loaded?.profileId).toBe(rec.profileId);
		expect(loaded?.entityId).toBeNull();
	});

	it("cold-disk eviction never drops bound profiles", async () => {
		const store = await newStore({ hotCacheSize: 1, coldDiskMax: 2 });
		// Build three profiles. The first is bound to an entity.
		const a = await store.createProfile({
			centroid: unit([1, 0, 0, 0]),
			embeddingModel: MODEL,
			confidence: 0.3,
			durationMs: 1500,
		});
		await store.bindEntity({ profileId: a.profileId, entityId: "ent_shaw" });
		await store.createProfile({
			centroid: unit([0, 1, 0, 0]),
			embeddingModel: MODEL,
			confidence: 0.3,
			durationMs: 1500,
		});
		await store.createProfile({
			centroid: unit([0, 0, 1, 0]),
			embeddingModel: MODEL,
			confidence: 0.3,
			durationMs: 1500,
		});
		// Cold tier is over `coldDiskMax`. The bound profile must survive.
		const loaded = await store.get(a.profileId);
		expect(loaded?.entityId).toBe("ent_shaw");
	});
});

describe("VoiceProfileStore — profile id is centroid-content-addressed", () => {
	it("two identical centroids yield the same profile id", async () => {
		const store = await newStore();
		const a = await store.createProfile({
			centroid: unit([1, 2, 3, 4]),
			embeddingModel: MODEL,
			confidence: 0.5,
			durationMs: 1500,
		});
		// createProfile twice with the same centroid writes to the same
		// profileId. Second write replaces the first record.
		const b = await store.createProfile({
			centroid: unit([1, 2, 3, 4]),
			embeddingModel: MODEL,
			confidence: 0.5,
			durationMs: 1500,
		});
		expect(b.profileId).toBe(a.profileId);
	});

	it("perturbed centroid yields a different profile id", async () => {
		const store = await newStore();
		const a = await store.createProfile({
			centroid: unit([1, 2, 3, 4]),
			embeddingModel: MODEL,
			confidence: 0.5,
			durationMs: 1500,
		});
		const b = await store.createProfile({
			centroid: unit([1, 2, 3, 4.001]),
			embeddingModel: MODEL,
			confidence: 0.5,
			durationMs: 1500,
		});
		expect(b.profileId).not.toBe(a.profileId);
	});
});

describe("VoiceProfileStore — VoiceProfileRecord shape sanity", () => {
	it("createProfile writes a schemaVersion=v1 record with all required fields", async () => {
		const store = await newStore();
		const rec: VoiceProfileRecord = await store.createProfile({
			centroid: unit([1, 0, 0, 0]),
			embeddingModel: MODEL,
			confidence: 0.9,
			durationMs: 2000,
		});
		expect(rec.schemaVersion).toBe("eliza.voice_profile_record.v1");
		expect(rec.embeddingDim).toBe(DIM);
		expect(rec.embeddingModel).toBe(MODEL);
		expect(rec.imprintClusterId).toMatch(/^cluster_/);
		expect(rec.consent.attributionAuthorized).toBe(false);
		expect(rec.consent.synthesisAuthorized).toBe(false);
		expect(rec.welfordM2).toHaveLength(DIM);
		expect(rec.variance).toHaveLength(DIM);
	});
});
