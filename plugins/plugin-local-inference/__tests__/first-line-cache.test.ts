/**
 * Coverage for `FirstLineCache`, the on-disk cache of pre-synthesized first
 * TTS sentences plus its voice-revision fingerprint/invalidation helpers.
 * Exercises the real filesystem against a temp directory.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_SENTENCE_SNIP_VERSION } from "@elizaos/shared";
import {
	_resetVoiceRevisionMemoForTesting,
	computeLocalVoiceRevision,
	fingerprintVoiceSettings,
	FirstLineCache,
	type FirstLineCacheKey,
	hashCacheKey,
} from "../src/services/voice/first-line-cache";

let tmpRoot: string;
const openCaches: FirstLineCache[] = [];

function makeCache(
	opts: Partial<ConstructorParameters<typeof FirstLineCache>[0]> = {},
) {
	const cache = new FirstLineCache({ rootDir: tmpRoot, ...opts });
	openCaches.push(cache);
	return cache;
}

function makeKey(over: Partial<FirstLineCacheKey> = {}): FirstLineCacheKey {
	return {
		algoVersion: FIRST_SENTENCE_SNIP_VERSION,
		provider: "elevenlabs",
		voiceId: "EXAVITQu4vr4xnSDxMaL",
		voiceRevision: "rev-aaaa",
		sampleRate: 44100,
		codec: "mp3",
		voiceSettingsFingerprint: fingerprintVoiceSettings({}),
		normalizedText: "got it",
		...over,
	};
}

function makeBytes(len = 32, fill = 0x42): Uint8Array {
	const b = new Uint8Array(len);
	b.fill(fill);
	return b;
}

beforeEach(() => {
	tmpRoot = mkdtempSync(path.join(tmpdir(), "fl-cache-"));
});
afterEach(() => {
	// Close every cache before removing its dir: an open SQLite (WAL) handle
	// blocks rmSync on Windows (EBUSY/EPERM); POSIX tolerates open handles.
	// close() is idempotent, so double-closing an already-closed cache is safe.
	for (const cache of openCaches.splice(0)) cache.close();
	vi.restoreAllMocks();
	rmSync(tmpRoot, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 50,
	});
});

describe("hashCacheKey", () => {
	it.each([
		[
			"got it",
			"fce913f6c62ec95a56db16e450716084252af96dd02057a514a01755680e3a79",
		],
		[
			"café 我知道了",
			"542f9736a8900dffd80595ad897de6a64c5fd66e59203ebbd2ce0f689710c3d4",
		],
	])(
		"retains the persisted version-one hash for %s",
		(normalizedText, digest) => {
			expect(
				hashCacheKey(
					makeKey({
						algoVersion: "1",
						provider: "kokoro",
						voiceId: "af_bella",
						voiceRevision: "revision",
						sampleRate: 24000,
						codec: "opus",
						voiceSettingsFingerprint: "settings",
						normalizedText,
					}),
				),
			).toBe(digest);
		},
	);

	it("changes when any key field changes", () => {
		const base = makeKey();
		const baseHash = hashCacheKey(base);
		expect(hashCacheKey({ ...base, algoVersion: "next" })).not.toBe(baseHash);
		expect(hashCacheKey({ ...base, voiceId: "other" })).not.toBe(baseHash);
		expect(hashCacheKey({ ...base, voiceRevision: "rev-bbbb" })).not.toBe(
			baseHash,
		);
		expect(hashCacheKey({ ...base, normalizedText: "sure thing" })).not.toBe(
			baseHash,
		);
		expect(hashCacheKey({ ...base, sampleRate: 24000 })).not.toBe(baseHash);
		expect(hashCacheKey({ ...base, codec: "opus" })).not.toBe(baseHash);
		expect(hashCacheKey({ ...base, provider: "kokoro" })).not.toBe(baseHash);
		expect(
			hashCacheKey({
				...base,
				voiceSettingsFingerprint: fingerprintVoiceSettings({ stability: 0.2 }),
			}),
		).not.toBe(baseHash);
	});
});

describe("fingerprintVoiceSettings", () => {
	it("is order-independent", () => {
		expect(fingerprintVoiceSettings({ stability: 0.5, style: 0.3 })).toBe(
			fingerprintVoiceSettings({ style: 0.3, stability: 0.5 }),
		);
	});
	it("differs when values differ", () => {
		expect(fingerprintVoiceSettings({ stability: 0.5 })).not.toBe(
			fingerprintVoiceSettings({ stability: 0.6 }),
		);
	});
});

describe("computeLocalVoiceRevision", () => {
	it("hashes the file contents", async () => {
		_resetVoiceRevisionMemoForTesting();
		const fA = path.join(tmpRoot, "a.bin");
		const fB = path.join(tmpRoot, "b.bin");
		writeFileSync(fA, "voice-pack-bytes");
		writeFileSync(fB, "model-bytes");
		const rev = await computeLocalVoiceRevision([fA, fB]);
		expect(rev).toMatch(/^[0-9a-f]{64}$/);

		writeFileSync(fA, "voice-pack-bytes-v2");
		_resetVoiceRevisionMemoForTesting();
		const rev2 = await computeLocalVoiceRevision([fA, fB]);
		expect(rev2).not.toBe(rev);
	});
	it("memoises by file list", async () => {
		_resetVoiceRevisionMemoForTesting();
		const fA = path.join(tmpRoot, "a.bin");
		writeFileSync(fA, "x");
		const rev1 = await computeLocalVoiceRevision([fA]);
		// Mutate file but expect the memoized result.
		writeFileSync(fA, "y");
		const rev2 = await computeLocalVoiceRevision([fA]);
		expect(rev2).toBe(rev1);
		_resetVoiceRevisionMemoForTesting();
		const rev3 = await computeLocalVoiceRevision([fA]);
		expect(rev3).not.toBe(rev1);
	});
});

describe("FirstLineCache — basics", () => {
	it("returns null on miss", () => {
		const cache = makeCache();
		expect(cache.get(makeKey())).toBeNull();
	});

	it("put then get round-trip", () => {
		const cache = makeCache();
		const ok = cache.put({
			...makeKey(),
			bytes: makeBytes(64),
			rawText: "Got it.",
			contentType: "audio/mpeg",
			durationMs: 500,
		});
		expect(ok).toBe(true);
		const got = cache.get(makeKey());
		expect(got).not.toBeNull();
		expect(got?.bytes.length).toBe(64);
		expect(got?.rawText).toBe("Got it.");
		expect(got?.contentType).toBe("audio/mpeg");
		expect(got?.durationMs).toBe(500);
		expect(got?.hitCount).toBe(1);
	});

	it("has() reflects put/delete", () => {
		const cache = makeCache();
		expect(cache.has(makeKey())).toBe(false);
		cache.put({
			...makeKey(),
			bytes: makeBytes(),
			rawText: "Got it.",
			contentType: "audio/mpeg",
			durationMs: 0,
		});
		expect(cache.has(makeKey())).toBe(true);
		cache.delete(makeKey());
		expect(cache.has(makeKey())).toBe(false);
	});
});

describe("FirstLineCache — F3 voice-swap safety", () => {
	it("Kokoro entry does NOT resolve under an ElevenLabs key", () => {
		const cache = makeCache();
		const kokoroKey = makeKey({
			provider: "kokoro",
			voiceId: "af_bella",
			voiceRevision: "kokoro-rev-1",
			sampleRate: 24000,
			codec: "opus",
		});
		cache.put({
			...kokoroKey,
			bytes: makeBytes(48, 0xaa),
			rawText: "Got it.",
			contentType: "audio/opus",
			durationMs: 0,
		});
		// Same normalized text but different provider/voice/revision → miss.
		const elevenLookup = makeKey({
			provider: "elevenlabs",
			voiceId: "EXAVITQu4vr4xnSDxMaL",
			voiceRevision: "eleven-rev-1",
		});
		expect(cache.get(elevenLookup)).toBeNull();
	});

	it.each(["voiceId", "voiceRevision"] as const)(
		"keeps independent entries when %s changes",
		(field) => {
			const cache = makeCache();
			const original = makeKey();
			const changed = makeKey({ [field]: "changed" });
			const write = (key: FirstLineCacheKey, fill: number) =>
				cache.put({
					...key,
					bytes: makeBytes(48, fill),
					rawText: "Got it.",
					contentType: "audio/mpeg",
					durationMs: 0,
				});
			expect(write(original, 1)).toBe(true);
			expect(cache.has(changed)).toBe(false);
			expect(write(changed, 2)).toBe(true);
			expect(cache.get(original)?.bytes[0]).toBe(1);
			expect(cache.get(changed)?.bytes[0]).toBe(2);
		},
	);

	it("different voiceSettingsFingerprint produces miss", () => {
		const cache = makeCache();
		const neutral = fingerprintVoiceSettings({});
		const stylised = fingerprintVoiceSettings({ stability: 0.2 });
		cache.put({
			...makeKey({ voiceSettingsFingerprint: neutral }),
			bytes: makeBytes(48),
			rawText: "Got it.",
			contentType: "audio/mpeg",
			durationMs: 0,
		});
		expect(
			cache.get(makeKey({ voiceSettingsFingerprint: stylised })),
		).toBeNull();
	});
});

describe("FirstLineCache — safety rejections", () => {
	it("rejects empty voiceRevision on put + on lookup", () => {
		const cache = makeCache();
		const ok = cache.put({
			...makeKey({ voiceRevision: "" }),
			bytes: makeBytes(48),
			rawText: "Got it.",
			contentType: "audio/mpeg",
			durationMs: 0,
		});
		expect(ok).toBe(false);
		expect(cache.get(makeKey({ voiceRevision: "" }))).toBeNull();
	});

	it("rejects empty bytes", () => {
		const cache = makeCache();
		const ok = cache.put({
			...makeKey(),
			bytes: new Uint8Array(0),
			rawText: "Got it.",
			contentType: "audio/mpeg",
			durationMs: 0,
		});
		expect(ok).toBe(false);
	});

	it("rejects entries larger than maxBytesPerEntry", () => {
		const cache = makeCache({ maxBytesPerEntry: 1024 });
		const ok = cache.put({
			...makeKey(),
			bytes: makeBytes(2048),
			rawText: "Got it.",
			contentType: "audio/mpeg",
			durationMs: 0,
		});
		expect(ok).toBe(false);
	});

	it("rejects > 10-word phrases via implicit wordCount", () => {
		const cache = makeCache();
		const ok = cache.put({
			...makeKey({
				normalizedText:
					"one two three four five six seven eight nine ten eleven",
			}),
			bytes: makeBytes(48),
			rawText: "One two three four five six seven eight nine ten eleven.",
			contentType: "audio/mpeg",
			durationMs: 0,
		});
		expect(ok).toBe(false);
	});

	it("noops when disabled", () => {
		const cache = makeCache({ disabled: true });
		expect(cache.isEnabled).toBe(false);
		expect(
			cache.put({
				...makeKey(),
				bytes: makeBytes(48),
				rawText: "Got it.",
				contentType: "audio/mpeg",
				durationMs: 0,
			}),
		).toBe(false);
		expect(cache.get(makeKey())).toBeNull();
	});
});

describe("FirstLineCache — LRU eviction", () => {
	it("persists access order across reopen and evicts the least recently used bytes", () => {
		let now = 1_700_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const keys = ["older", "newer", "third"].map((normalizedText) =>
			makeKey({ normalizedText }),
		);
		const cache = makeCache({ maxBytes: 128 });
		for (const key of keys.slice(0, 2)) {
			expect(
				cache.put({
					...key,
					bytes: makeBytes(64),
					rawText: key.normalizedText,
					contentType: "audio/mpeg",
					durationMs: 0,
				}),
			).toBe(true);
			now += 1000;
		}
		expect(cache.get(keys[0])?.lastAccessedAtMs).toBe(now);
		cache.close();
		now += 1000;
		const reopened = makeCache({ maxBytes: 128 });
		expect(
			reopened.put({
				...keys[2],
				bytes: makeBytes(64),
				rawText: "Third.",
				contentType: "audio/mpeg",
				durationMs: 0,
			}),
		).toBe(true);
		expect(keys.map((key) => reopened.has(key))).toEqual([true, false, true]);
		expect(reopened.stats()).toMatchObject({ entries: 2, bytes: 128 });
	});
});

describe("FirstLineCache — persistence across reopen", () => {
	it("retains bytes, hit counts and stats through reopen, then expires stored entries", () => {
		const keys = [makeKey(), makeKey({ normalizedText: "sure thing" })];
		const bytes = makeBytes(48);
		const cache = makeCache({ ttlDays: 1 });
		for (const key of keys) {
			expect(
				cache.put({
					...key,
					bytes,
					rawText: key.normalizedText,
					contentType: "audio/mpeg",
					durationMs: 0,
				}),
			).toBe(true);
		}
		cache.close();
		for (let count = 1; count <= 3; count++) {
			const reopened = makeCache({ ttlDays: 1 });
			for (const key of keys) {
				const hit = reopened.get(key);
				expect(hit).not.toBeNull();
				expect(Array.from(hit!.bytes)).toEqual(Array.from(bytes));
				expect(hit?.hitCount).toBe(count);
			}
			expect(reopened.stats()).toMatchObject({
				dbReady: true,
				entries: 2,
				bytes: 96,
			});
			reopened.close();
		}
		const reopened = makeCache({ ttlDays: 1 });
		expect(reopened.sweep(Date.now() + 2 * 86_400_000)).toBe(2);
		expect(keys.map((key) => reopened.has(key))).toEqual([false, false]);
		expect(reopened.stats()).toMatchObject({ entries: 0, bytes: 0 });
	});

	it("drops orphan rows when the blob file is missing", () => {
		const cache1 = makeCache();
		cache1.put({
			...makeKey(),
			bytes: makeBytes(48),
			rawText: "Got it.",
			contentType: "audio/mpeg",
			durationMs: 0,
		});
		const blobs = path.join(tmpRoot, "blobs");
		// Find and unlink any .mp3 blob recursively (one entry).
		const { readdirSync, unlinkSync } =
			require("node:fs") as typeof import("node:fs");
		function purge(dir: string) {
			for (const ent of readdirSync(dir, { withFileTypes: true })) {
				const f = path.join(dir, ent.name);
				if (ent.isDirectory()) purge(f);
				else if (f.endsWith(".mp3")) unlinkSync(f);
			}
		}
		purge(blobs);

		const got = cache1.get(makeKey());
		expect(got).toBeNull();
	});
});

describe("FirstLineCache — blob layout", () => {
	it("writes blobs under <root>/blobs/<provider>/<voiceId>/<voiceRevision>/", () => {
		const cache = makeCache();
		cache.put({
			...makeKey({
				provider: "elevenlabs",
				voiceId: "EXAVITQu4vr4xnSDxMaL",
				voiceRevision: "rev-aaaa",
			}),
			bytes: makeBytes(48),
			rawText: "Got it.",
			contentType: "audio/mpeg",
			durationMs: 0,
		});
		const expectedDir = path.join(
			tmpRoot,
			"blobs",
			"elevenlabs",
			"EXAVITQu4vr4xnSDxMaL",
			"rev-aaaa",
		);
		expect(statSync(expectedDir).isDirectory()).toBe(true);
	});
});
