/**
 * Exercises {@link EncryptedCachePseudonymMapStore} (#14805): the map is a
 * SECRET artifact — never persisted in plaintext, never readable with the
 * wrong key, never accepted when tampered or malformed, and confined to its
 * single dedicated cache key (structurally outside every retrieval surface).
 */

import { describe, expect, test } from "vitest";
import type { PseudonymMapSnapshot } from "./pii-pseudonym-map.js";
import { CorpusPseudonymMap } from "./pii-pseudonym-map.js";
import {
	EncryptedCachePseudonymMapStore,
	PII_PSEUDONYM_MAP_CACHE_KEY,
	PseudonymMapStoreError,
} from "./pii-pseudonym-map-store.js";
import type { ScrubMarkerCache } from "./pii-scrub-markers.js";

const ENCRYPTION_SALT = "test-secret-salt";
const RULESET = "2026.07";

function makeCache(): ScrubMarkerCache & { raw: Map<string, unknown> } {
	const raw = new Map<string, unknown>();
	return {
		raw,
		getCache: async <T>(key: string): Promise<T | undefined> =>
			raw.has(key) ? (raw.get(key) as T) : undefined,
		setCache: async <T>(key: string, value: T): Promise<boolean> => {
			raw.set(key, value);
			return true;
		},
		deleteCache: async (key: string): Promise<boolean> => raw.delete(key),
	};
}

function seededSnapshot(): PseudonymMapSnapshot {
	const map = new CorpusPseudonymMap({ salt: "map-mint-salt" });
	map.assign({
		clusterId: "entity:john",
		kind: "person",
		aliases: ["John Smith", "Johnny", "@jsmith"],
		identities: [{ platform: "discord", handle: "jsmith" }],
		evidence: ["linked via discord profile"],
		rulesetVersion: RULESET,
	});
	return map.toSnapshot();
}

describe("EncryptedCachePseudonymMapStore round-trip", () => {
	test("save -> load returns a deep-equal snapshot", async () => {
		const cache = makeCache();
		const store = new EncryptedCachePseudonymMapStore(cache, {
			encryptionSalt: ENCRYPTION_SALT,
		});
		const snapshot = seededSnapshot();
		await store.save(snapshot);
		const loaded = await store.load();
		expect(loaded).toEqual(snapshot);
	});

	test("load with nothing persisted returns null (not an empty map)", async () => {
		const store = new EncryptedCachePseudonymMapStore(makeCache(), {
			encryptionSalt: ENCRYPTION_SALT,
		});
		expect(await store.load()).toBeNull();
	});

	test("save is an idempotent overwrite of the single artifact", async () => {
		const cache = makeCache();
		const store = new EncryptedCachePseudonymMapStore(cache, {
			encryptionSalt: ENCRYPTION_SALT,
		});
		const snapshot = seededSnapshot();
		await store.save(snapshot);
		await store.save(snapshot);
		expect(cache.raw.size).toBe(1);
		expect(await store.load()).toEqual(snapshot);
	});
});

describe("the map artifact is secret at rest", () => {
	test("the persisted bytes are ciphertext: no alias, pseudonym, cluster id, or JSON structure leaks", async () => {
		const cache = makeCache();
		const store = new EncryptedCachePseudonymMapStore(cache, {
			encryptionSalt: ENCRYPTION_SALT,
		});
		const snapshot = seededSnapshot();
		await store.save(snapshot);

		expect([...cache.raw.keys()]).toEqual([PII_PSEUDONYM_MAP_CACHE_KEY]);
		const stored = cache.raw.get(PII_PSEUDONYM_MAP_CACHE_KEY);
		expect(typeof stored).toBe("string");
		const blob = stored as string;
		expect(blob.startsWith("v2:")).toBe(true);
		// The alias<->pseudonym inversion table must not be readable in the raw
		// artifact — that is the entire point of the store.
		const cluster = snapshot.clusters[0];
		for (const sensitive of [
			...cluster.aliases,
			cluster.pseudonym,
			cluster.clusterId,
			"jsmith",
			"aliases",
			"pseudonym",
			"{",
		]) {
			expect(blob).not.toContain(sensitive);
		}
	});

	test("loading with the wrong salt throws (fail-closed, never a partial map)", async () => {
		const cache = makeCache();
		const writer = new EncryptedCachePseudonymMapStore(cache, {
			encryptionSalt: ENCRYPTION_SALT,
		});
		await writer.save(seededSnapshot());
		const reader = new EncryptedCachePseudonymMapStore(cache, {
			encryptionSalt: "a-different-salt",
		});
		await expect(reader.load()).rejects.toThrow(PseudonymMapStoreError);
	});

	test("tampered ciphertext throws (GCM authentication)", async () => {
		const cache = makeCache();
		const store = new EncryptedCachePseudonymMapStore(cache, {
			encryptionSalt: ENCRYPTION_SALT,
		});
		await store.save(seededSnapshot());
		const blob = cache.raw.get(PII_PSEUDONYM_MAP_CACHE_KEY) as string;
		const parts = blob.split(":");
		// Flip one ciphertext nibble.
		const body = parts[2];
		const flipped = `${body.slice(0, 4)}${body[4] === "0" ? "1" : "0"}${body.slice(5)}`;
		cache.raw.set(
			PII_PSEUDONYM_MAP_CACHE_KEY,
			[parts[0], parts[1], flipped, parts[3]].join(":"),
		);
		await expect(store.load()).rejects.toThrow(PseudonymMapStoreError);
	});

	test("a non-ciphertext stored value throws instead of being interpreted", async () => {
		const cache = makeCache();
		const store = new EncryptedCachePseudonymMapStore(cache, {
			encryptionSalt: ENCRYPTION_SALT,
		});
		cache.raw.set(
			PII_PSEUDONYM_MAP_CACHE_KEY,
			JSON.stringify(seededSnapshot()),
		);
		await expect(store.load()).rejects.toThrow(/not v2 ciphertext/);
	});

	test("a decryptable but malformed snapshot throws (structural fail-closed)", async () => {
		const cache = makeCache();
		const store = new EncryptedCachePseudonymMapStore(cache, {
			encryptionSalt: ENCRYPTION_SALT,
		});
		const bad = {
			...seededSnapshot(),
			clusters: [{ clusterId: "entity:x" }],
		} as unknown as PseudonymMapSnapshot;
		await expect(store.save(bad)).rejects.toThrow();
		// Nothing was persisted by the rejected save.
		expect(cache.raw.size).toBe(0);
	});

	test("constructor refuses an empty encryption salt", () => {
		expect(
			() =>
				new EncryptedCachePseudonymMapStore(makeCache(), {
					encryptionSalt: "",
				}),
		).toThrow(PseudonymMapStoreError);
	});

	test("a failed cache write surfaces as an error, never a silent no-persist", async () => {
		const cache = makeCache();
		const failing: ScrubMarkerCache = {
			...cache,
			setCache: async () => false,
		};
		const store = new EncryptedCachePseudonymMapStore(failing, {
			encryptionSalt: ENCRYPTION_SALT,
		});
		await expect(store.save(seededSnapshot())).rejects.toThrow(/NOT persisted/);
	});
});
