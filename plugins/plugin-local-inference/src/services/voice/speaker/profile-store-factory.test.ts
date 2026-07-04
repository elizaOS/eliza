/**
 * Unit tests for the shared VoiceProfileStore factory (#12257). Real store,
 * real temp dir on disk — proves both diarization pipelines resolve one
 * instance so an enrollment on one path is a match on the other, and that a
 * failed init is not memoized.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	__resetSharedVoiceProfileStoresForTest,
	getSharedVoiceProfileStore,
	resolveVoiceProfilesDir,
} from "./profile-store-factory";

const MODEL = "wespeaker-resnet34-lm-int8";

function unitCentroid(seed: number): Float32Array {
	const v = new Float32Array(256);
	for (let i = 0; i < v.length; i += 1) {
		v[i] = Math.sin((i + 1) * (seed + 1) * 0.01);
	}
	return v;
}

afterEach(() => {
	__resetSharedVoiceProfileStoresForTest();
});

describe("getSharedVoiceProfileStore", () => {
	it("memoizes one initialized store per root dir", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "vp-factory-"));
		const a = await getSharedVoiceProfileStore(dir);
		const b = await getSharedVoiceProfileStore(dir);
		expect(a).toBe(b);
	});

	it("shares identities across both pipeline consumers (enroll via A, match via B)", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "vp-factory-"));
		// Pipeline A gets the store and enrolls a speaker.
		const pipelineA = await getSharedVoiceProfileStore(dir);
		const centroid = unitCentroid(3);
		const created = await pipelineA.createProfile({
			centroid,
			embeddingModel: MODEL,
			entityId: null,
			confidence: 0.9,
			durationMs: 2_000,
		});

		// Pipeline B resolves the SAME store and matches the same voice.
		const pipelineB = await getSharedVoiceProfileStore(dir);
		expect(pipelineB).toBe(pipelineA);
		const match = await pipelineB.findBestMatch({
			embedding: centroid,
			embeddingModel: MODEL,
		});
		expect(match?.profile.id).toBe(created.profileId);
	});

	it("does not memoize a failed init (init errors are retryable)", async () => {
		// Root nested under a regular file: mkdir(recursive) fails with ENOTDIR.
		const base = mkdtempSync(path.join(tmpdir(), "vp-factory-"));
		const asFile = path.join(base, "occupied");
		writeFileSync(asFile, "not a directory");
		const bad = path.join(asFile, "voice-profiles");
		const first = getSharedVoiceProfileStore(bad);
		await expect(first).rejects.toBeInstanceOf(Error);
		// A second call returns a fresh (not the cached rejected) promise.
		const second = getSharedVoiceProfileStore(bad);
		expect(second).not.toBe(first);
		await expect(second).rejects.toBeInstanceOf(Error);
	});
});

describe("resolveVoiceProfilesDir", () => {
	it("roots voice-profiles under the resolved state dir", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "state-"));
		const resolved = resolveVoiceProfilesDir({ ELIZA_STATE_DIR: dir });
		expect(resolved).toBe(path.join(dir, "voice-profiles"));
	});
});
