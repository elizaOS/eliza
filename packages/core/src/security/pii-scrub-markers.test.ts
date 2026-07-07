/**
 * Content-hash idempotency tests for the PII scrub done-markers (#14808).
 *
 * These prove the resume/idempotency contract the async rails depend on:
 *   - the key is `pii:<sha256(content)>:v<rulesetVersion>` (content-addressed),
 *   - same content + same ruleset -> same key -> skip (re-scrub no-ops),
 *   - changed content OR bumped ruleset -> new key -> NOT skipped,
 *   - a marker is only "done" after `markScrubDone`, and survives in the cache
 *     (crash-and-rerun resumes with zero cursor state - the marker IS the state).
 */

import { describe, expect, it } from "vitest";
import {
	getScrubMarker,
	hashScrubContent,
	isScrubDone,
	markScrubDone,
	PII_SCRUB_MARKER_PREFIX,
	type ScrubMarkerCache,
	scrubMarkerKey,
	scrubMarkerKeyForContent,
} from "./pii-scrub-markers.js";

/** In-memory ScrubMarkerCache standing in for the DB-backed runtime cache. */
function makeCache(): ScrubMarkerCache & { store: Map<string, unknown> } {
	const store = new Map<string, unknown>();
	return {
		store,
		async getCache<T>(key: string): Promise<T | undefined> {
			return store.has(key) ? (store.get(key) as T) : undefined;
		},
		async setCache<T>(key: string, value: T): Promise<boolean> {
			store.set(key, value);
			return true;
		},
		async deleteCache(key: string): Promise<boolean> {
			return store.delete(key);
		},
	};
}

const RULESET = "2026.07";

describe("pii-scrub done-marker key", () => {
	it("is content-addressed: pii:<sha256(content)>:v<rulesetVersion>", () => {
		const content = "call me at john@example.com";
		const hash = hashScrubContent(content);
		expect(hash).toMatch(/^[0-9a-f]{64}$/);
		expect(scrubMarkerKeyForContent(content, RULESET)).toBe(
			`${PII_SCRUB_MARKER_PREFIX}:${hash}:v${RULESET}`,
		);
		expect(scrubMarkerKey(hash, RULESET)).toBe(`pii:${hash}:v${RULESET}`);
	});

	it("is stable: identical content hashes identically across calls", () => {
		expect(hashScrubContent("abc")).toBe(hashScrubContent("abc"));
		expect(scrubMarkerKeyForContent("abc", RULESET)).toBe(
			scrubMarkerKeyForContent("abc", RULESET),
		);
	});

	it("differs when content differs (edit -> new key -> re-scrub)", () => {
		expect(scrubMarkerKeyForContent("abc", RULESET)).not.toBe(
			scrubMarkerKeyForContent("abcd", RULESET),
		);
	});

	it("differs when ruleset version differs (bump -> new key -> re-scrub)", () => {
		expect(scrubMarkerKeyForContent("abc", "2026.07")).not.toBe(
			scrubMarkerKeyForContent("abc", "2026.08"),
		);
	});

	it("refuses an empty ruleset version (no version-collapsed namespace)", () => {
		expect(() => scrubMarkerKey("deadbeef", "")).toThrow(/rulesetVersion/);
		expect(() => scrubMarkerKeyForContent("abc", "")).toThrow(/rulesetVersion/);
	});

	it("refuses an empty content hash", () => {
		expect(() => scrubMarkerKey("", RULESET)).toThrow(/contentHash/);
	});
});

describe("pii-scrub idempotency (isScrubDone / markScrubDone)", () => {
	it("is not done before it is marked", async () => {
		const cache = makeCache();
		expect(await isScrubDone(cache, "secret text", RULESET)).toBe(false);
	});

	it("is done after markScrubDone for the SAME content + ruleset", async () => {
		const cache = makeCache();
		const content = "secret text";
		await markScrubDone(cache, content, {
			rulesetVersion: RULESET,
			modelId: "tier0",
			tier0Only: true,
		});
		expect(await isScrubDone(cache, content, RULESET)).toBe(true);
	});

	it("re-scrub of UNCHANGED content is a no-op (same key already present)", async () => {
		const cache = makeCache();
		const content = "unchanged content";
		await markScrubDone(cache, content, {
			rulesetVersion: RULESET,
			modelId: "local-gguf",
			tier0Only: false,
		});
		// A second enqueue of the exact same content resolves to the same key.
		expect(await isScrubDone(cache, content, RULESET)).toBe(true);
		expect(cache.store.size).toBe(1);
		// Re-marking the same content does not create a second entry.
		await markScrubDone(cache, content, {
			rulesetVersion: RULESET,
			modelId: "local-gguf",
			tier0Only: false,
		});
		expect(cache.store.size).toBe(1);
	});

	it("CHANGED content is NOT skipped (different sha -> not done)", async () => {
		const cache = makeCache();
		await markScrubDone(cache, "original", {
			rulesetVersion: RULESET,
			modelId: "tier0",
			tier0Only: true,
		});
		expect(await isScrubDone(cache, "edited", RULESET)).toBe(false);
	});

	it("a RULESET bump re-scrubs the same content (new v<...> key)", async () => {
		const cache = makeCache();
		const content = "same content";
		await markScrubDone(cache, content, {
			rulesetVersion: "2026.07",
			modelId: "tier0",
			tier0Only: true,
		});
		expect(await isScrubDone(cache, content, "2026.07")).toBe(true);
		// Ruleset upgraded -> the old marker does not satisfy the new version.
		expect(await isScrubDone(cache, content, "2026.08")).toBe(false);
	});

	it("stores auditable metadata but never the raw content", async () => {
		const cache = makeCache();
		const content = "my ssn is 123-45-6789";
		await markScrubDone(cache, content, {
			rulesetVersion: RULESET,
			modelId: "local-gguf",
			tier0Only: false,
			completedAt: 1_700_000_000_000,
		});
		const marker = await getScrubMarker(cache, content, RULESET);
		expect(marker).toBeDefined();
		expect(marker?.contentHash).toBe(hashScrubContent(content));
		expect(marker?.rulesetVersion).toBe(RULESET);
		expect(marker?.modelId).toBe("local-gguf");
		expect(marker?.tier0Only).toBe(false);
		expect(marker?.completedAt).toBe(1_700_000_000_000);
		// The raw content / raw PII is never persisted in the marker.
		expect(JSON.stringify(marker)).not.toContain("123-45-6789");
		expect(JSON.stringify(marker)).not.toContain(content);
	});

	it("survives a simulated crash: marker present after 'restart' -> resume skips", async () => {
		const cache = makeCache();
		const done = "already scrubbed before crash";
		const pending = "was in-flight, not yet marked";
		await markScrubDone(cache, done, {
			rulesetVersion: RULESET,
			modelId: "tier0",
			tier0Only: true,
		});
		// Simulate restart: same durable cache (store survives), no cursor state.
		const afterRestart: ScrubMarkerCache = {
			getCache: cache.getCache,
			setCache: cache.setCache,
			deleteCache: cache.deleteCache,
		};
		expect(await isScrubDone(afterRestart, done, RULESET)).toBe(true);
		expect(await isScrubDone(afterRestart, pending, RULESET)).toBe(false);
	});
});
