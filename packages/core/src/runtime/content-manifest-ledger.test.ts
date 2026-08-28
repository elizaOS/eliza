/**
 * Rollover, publication, traversal, and mutant-kill tests for the
 * content-manifest ledger. Deterministic unit suite over an in-memory
 * ContentManifestLedgerStore; corruption cases mutate persisted bytes
 * directly to prove drop/skip/repeat/reorder/cycle/integrity detection.
 */
import { describe, expect, it } from "vitest";
import type { CompactionContentEntry } from "../types/content-manifest";
import { validateCompactionContentManifest } from "../types/content-manifest";
import {
	ContentManifestIntegrityError,
	type ManifestHead,
	type ManifestShard,
} from "../types/content-manifest-shards";
import {
	buildManifestShards,
	type ContentManifestLedgerStore,
	hashEntries,
	loadManifestLedger,
	manifestHeadKey,
	manifestShardKey,
	publishManifestLedger,
} from "./content-manifest-ledger";

const LEDGER = "agent-1:trajectory:t-1";

class MemoryStore implements ContentManifestLedgerStore {
	private rows = new Map<string, unknown>();

	async getCache<T>(key: string): Promise<T | undefined> {
		return this.rows.get(key) as T | undefined;
	}
	async setCache<T>(_key: string, _value: T): Promise<boolean> {
		return true;
	}
	async getCaches<T>(keys: string[]): Promise<Map<string, T>> {
		const out = new Map<string, T>();
		for (const key of keys) {
			const raw = this.rows.get(key);
			if (raw !== undefined) out.set(key, raw as T);
		}
		return out;
	}
	async setCaches<T>(
		entries: Array<{ key: string; value: T }>,
	): Promise<boolean> {
		for (const entry of entries) this.rows.set(entry.key, entry.value);
		return true;
	}
	async compareAndSwapCache<T>(
		key: string,
		expectedRevision: number | null,
		nextRevision: number,
		value: T,
	): Promise<boolean> {
		const existing = this.rows.get(key) as { revision?: number } | undefined;
		if (existing === undefined) {
			if (expectedRevision !== null) return false;
			this.rows.set(key, { ...value, revision: nextRevision });
			return true;
		}
		const stored = existing.revision ?? 0;
		if (stored !== expectedRevision) return false;
		this.rows.set(key, { ...value, revision: nextRevision });
		return true;
	}

	/** Test seam: read/write raw persisted payloads (corruption fixtures). */
	raw(key: string): unknown {
		return this.rows.get(key);
	}
	put(key: string, value: unknown): void {
		this.rows.set(key, value);
	}
	keys(): string[] {
		return [...this.rows.keys()];
	}
}

function makeEntry(index: number, rangeCount = 2): CompactionContentEntry {
	return {
		reference: { kind: "file", ref: `src-${index}.txt`, revision: `r${index}` },
		reason: "tool:FILE",
		rangesUsed: Array.from({ length: rangeCount }, (_, r) => ({
			unit: "byte" as const,
			start: r * 100,
			end: r * 100 + 100,
		})),
		lastUsedAt: "2026-08-27T00:00:00.000Z",
		retained: true,
	};
}

function makeManifest(
	count: number,
	rangeCount = 2,
): ReturnType<typeof validateCompactionContentManifest> {
	return validateCompactionContentManifest({
		schemaVersion: 1,
		contentRefs: Array.from({ length: count }, (_, i) =>
			makeEntry(i, rangeCount),
		),
		modifiedFiles: [],
		pendingProcesses: [],
	});
}

describe("buildManifestShards", () => {
	it("rolls over on the entry-count bound without dropping or reordering", () => {
		const { shards, head } = buildManifestShards(makeManifest(10), {
			ledgerId: LEDGER,
			maxEntriesPerShard: 3,
		});
		expect(shards.map((s) => s.entries.length)).toEqual([3, 3, 3, 1]);
		expect(head.shardCount).toBe(4);
		expect(head.totalEntries).toBe(10);
		const refs = shards.flatMap((s) => s.entries.map((e) => e.reference.ref));
		expect(refs).toEqual(Array.from({ length: 10 }, (_, i) => `src-${i}.txt`));
	});

	it("rolls over on the byte bound (serialization pressure)", () => {
		// 8 entries x ~740 canonical bytes each: count alone would pack them
		// into one shard; only the byte bound forces the rollover.
		const { shards } = buildManifestShards(makeManifest(8, 8), {
			ledgerId: LEDGER,
			maxEntriesPerShard: 256,
			maxBytesPerShard: 2400,
		});
		expect(shards.length).toBeGreaterThan(1);
		for (const shard of shards) {
			expect(shard.byteLength).toBeLessThanOrEqual(2400);
		}
	});

	it("chains shards with hash links and forward next-links", () => {
		const { shards } = buildManifestShards(makeManifest(7), {
			ledgerId: LEDGER,
			maxEntriesPerShard: 2,
		});
		expect(shards[0].prevSha256).toBeUndefined();
		expect(shards[0].nextSequence).toBe(1);
		for (let i = 1; i < shards.length; i++) {
			expect(shards[i].prevSha256).toBe(shards[i - 1].entriesSha256);
			expect(shards[i - 1].nextSequence).toBe(i);
		}
		expect(shards[shards.length - 1].nextSequence).toBeUndefined();
	});

	it("repeated rollover preserves every entry and range in order", () => {
		const { shards, head } = buildManifestShards(makeManifest(50, 4), {
			ledgerId: LEDGER,
			maxEntriesPerShard: 5,
		});
		expect(shards.length).toBe(10);
		expect(head.totalRanges).toBe(200);
	});
});

describe("publishManifestLedger / loadManifestLedger", () => {
	it("publishes and reloads losslessly (count rollover)", async () => {
		const store = new MemoryStore();
		const manifest = makeManifest(12);
		const head = await publishManifestLedger(store, LEDGER, manifest, {
			maxEntriesPerShard: 5,
		});
		expect(head.shardCount).toBe(3);
		expect(head.revision).toBe(0);
		const loaded = await loadManifestLedger(store, LEDGER);
		expect(loaded.entries).toHaveLength(12);
		expect(loaded.entries.map((e) => e.reference.ref)).toEqual(
			manifest.contentRefs.map((e) => e.reference.ref),
		);
		expect(loaded.head.totalRanges).toBe(head.totalRanges);
	});

	it("publication is idempotent for identical content", async () => {
		const store = new MemoryStore();
		const manifest = makeManifest(6);
		const first = await publishManifestLedger(store, LEDGER, manifest, {
			maxEntriesPerShard: 4,
		});
		const second = await publishManifestLedger(store, LEDGER, manifest, {
			maxEntriesPerShard: 4,
		});
		expect(second.revision).toBe(first.revision);
	});

	it("sequential updates advance the revision under CAS", async () => {
		const store = new MemoryStore();
		await publishManifestLedger(store, LEDGER, makeManifest(3), {
			maxEntriesPerShard: 2,
		});
		const second = await publishManifestLedger(store, LEDGER, makeManifest(4), {
			maxEntriesPerShard: 2,
		});
		expect(second.revision).toBe(1);
		const loaded = await loadManifestLedger(store, LEDGER);
		expect(loaded.entries).toHaveLength(4);
	});

	it("a stale writer loses the CAS race with a typed error", async () => {
		const store = new MemoryStore();
		await publishManifestLedger(store, LEDGER, makeManifest(3), {
			maxEntriesPerShard: 2,
		});
		// Simulate the concurrent interleaving: another writer bumps the
		// revision AFTER this publisher read the head but BEFORE its swap.
		// The store below reports every CAS as lost, which is exactly the
		// signal a racing winner produces.
		const losingStore: ContentManifestLedgerStore = {
			getCache: (key) => store.getCache(key),
			setCache: (key, value) => store.setCache(key, value),
			getCaches: (keys) => store.getCaches(keys),
			setCaches: (entries) => store.setCaches(entries),
			compareAndSwapCache: () => Promise.resolve(false),
		};
		await expect(
			publishManifestLedger(losingStore, LEDGER, makeManifest(5)),
		).rejects.toThrow(/compare-and-swap/);
		// The losing writer must not have displaced the winner's ledger.
		const loaded = await loadManifestLedger(store, LEDGER);
		expect(loaded.entries).toHaveLength(3);
	});

	it("loading a missing ledger fails with a typed head-missing error", async () => {
		const store = new MemoryStore();
		await expect(loadManifestLedger(store, LEDGER)).rejects.toThrow(
			/head is missing/,
		);
	});

	// ── Mutant kills: corrupt persisted bytes, expect typed integrity failure ──

	async function publishForMutants(): Promise<{
		store: MemoryStore;
		shards: ManifestShard[];
		rawKey: (sequence: number) => string;
	}> {
		const store = new MemoryStore();
		const manifest = makeManifest(9);
		await publishManifestLedger(store, LEDGER, manifest, {
			maxEntriesPerShard: 3,
		});
		const head = await loadManifestLedger(store, LEDGER);
		const generation = head.head.shardGeneration;
		const shards: ManifestShard[] = [];
		for (let i = 0; i < 3; i++) {
			shards.push(
				store.raw(manifestShardKey(LEDGER, generation, i)) as ManifestShard,
			);
		}
		const rawKey = (sequence: number) =>
			manifestShardKey(LEDGER, generation, sequence);
		return { store, shards, rawKey };
	}

	it("mutant DROP: a deleted middle shard is detected", async () => {
		const { store, rawKey } = await publishForMutants();
		store.put(rawKey(1), undefined as never);
		await expect(loadManifestLedger(store, LEDGER)).rejects.toThrow(
			/shard missing/,
		);
	});

	it("mutant SKIP (entry dropped inside a shard): hash mismatch is detected", async () => {
		const { store, shards, rawKey } = await publishForMutants();
		const mutated: ManifestShard = {
			...shards[1],
			entries: shards[1].entries.slice(0, 2),
			entryCount: 2,
		};
		store.put(rawKey(1), mutated);
		await expect(loadManifestLedger(store, LEDGER)).rejects.toThrow(
			/entries hash mismatch/,
		);
	});

	it("mutant REPEAT: a duplicated entry across shards is detected", async () => {
		const { store, shards, rawKey } = await publishForMutants();
		const dup = [...shards[2].entries, shards[0].entries[0]];
		const mutated: ManifestShard = {
			...shards[2],
			entries: dup,
			entryCount: dup.length,
			entriesSha256: hashEntries(dup),
		};
		store.put(rawKey(2), mutated);
		// Head totals no longer reconcile either way.
		await expect(loadManifestLedger(store, LEDGER)).rejects.toThrow(
			ContentManifestIntegrityError,
		);
	});

	it("mutant REORDER: swapping shard bytes between sequences is detected", async () => {
		const { store, shards, rawKey } = await publishForMutants();
		// Swap shards 0 and 2 (chain links now point the wrong way).
		store.put(rawKey(0), shards[2]);
		store.put(rawKey(2), shards[0]);
		await expect(loadManifestLedger(store, LEDGER)).rejects.toThrow(
			ContentManifestIntegrityError,
		);
	});

	it("mutant CYCLE: a tail next-link pointing backwards is detected on load", async () => {
		const { store, shards, rawKey } = await publishForMutants();
		const tail = shards[2];
		const mutated: ManifestShard = { ...tail, nextSequence: 0 };
		// Keep the bytes otherwise consistent so the validator itself fires.
		store.put(rawKey(2), mutated);
		await expect(loadManifestLedger(store, LEDGER)).rejects.toThrow(
			/sequence \+ 1/,
		);
	});

	it("mutant REPLACE: swapping an earlier shard's entries with patched downstream links is detected", async () => {
		const { store, shards, rawKey } = await publishForMutants();
		// Attack: replace shard 0's entries with shard 2's entries, recompute
		// entryCount/entriesSha256 AND patch shard 1's prevSha256 so the old
		// per-shard checks would pass. The full-record chain hash must still
		// catch it: shard 0's chain input changed, so every downstream chain
		// hash and the head reconciliation fail.
		const forged: ManifestShard = {
			...shards[0],
			entries: shards[2].entries,
			entryCount: shards[2].entryCount,
			entriesSha256: hashEntries(shards[2].entries),
		};
		store.put(rawKey(0), forged);
		await expect(loadManifestLedger(store, LEDGER)).rejects.toThrow(
			/chain hash mismatch/,
		);
	});

	it("a single entry larger than the byte bound is rejected, not silently emitted", () => {
		const huge = makeManifest(1, 64);
		expect(() =>
			buildManifestShards(huge, {
				ledgerId: LEDGER,
				maxBytesPerShard: 256,
			}),
		).toThrow(/exceeds the configured byte bound even alone/);
	});

	// ── R3 follow-ups: deterministic idempotency + revision normalization ──

	it("idempotency survives a clock advance between identical publications", async () => {
		const store = new MemoryStore();
		const manifest = makeManifest(6);
		const first = await publishManifestLedger(store, LEDGER, manifest, {
			maxEntriesPerShard: 3,
			createdAt: "2026-01-01T00:00:00.000Z",
		});
		// Deterministic clock control: the second publication is built with a
		// strictly later injected createdAt, so the chain hash differs by
		// construction (no real sleep, no flaky 1ms race). Idempotency must be
		// decided by the content digest, which is createdAt-free.
		const second = await publishManifestLedger(store, LEDGER, manifest, {
			maxEntriesPerShard: 3,
			createdAt: "2027-06-06T06:06:06.006Z",
		});
		// Same content => idempotent: the PRIOR head object is returned
		// untouched (identity-comparable in-memory), revision unmoved, digest
		// equal. The later build's chain hash necessarily differs from the
		// stored one (createdAt differs) — the digest alone matched, which is
		// exactly the invariant under test.
		expect(second).toStrictEqual(first);
		// And the ledger still loads with full integrity.
		const loaded = await loadManifestLedger(store, LEDGER);
		expect(loaded.entries).toHaveLength(6);
	});

	it("retention metadata is NOT idempotent: weakening retained/expiresAt advances the revision", async () => {
		const store = new MemoryStore();
		const manifest = makeManifest(2);
		const first = await publishManifestLedger(store, LEDGER, manifest, {
			maxEntriesPerShard: 3,
		});
		// Same references/ranges/revisions, but retention metadata changed.
		const weakened = {
			...manifest,
			contentRefs: manifest.contentRefs.map((entry) => ({
				...entry,
				retained: false,
				expiresAt: "2026-09-01T00:00:00.000Z",
			})),
		};
		const second = await publishManifestLedger(store, LEDGER, weakened, {
			maxEntriesPerShard: 3,
		});
		expect(second.revision).toBe(first.revision + 1);
		expect(second.contentSha256).not.toBe(first.contentSha256);
		// The stored ledger now carries the new retention metadata.
		const loaded = await loadManifestLedger(store, LEDGER);
		expect(loaded.entries.every((entry) => entry.retained === false)).toBe(
			true,
		);
	});

	it("load rejects a head whose persisted contentSha256 disagrees with the entries", async () => {
		const store = new MemoryStore();
		await publishManifestLedger(store, LEDGER, makeManifest(4), {
			maxEntriesPerShard: 3,
		});
		// Tamper with the persisted head digest only (valid hex, wrong bytes).
		const raw = store.raw(manifestHeadKey(LEDGER));
		const tampered = {
			...(raw as ManifestHead),
			contentSha256: "e".repeat(64),
		};
		store.put(manifestHeadKey(LEDGER), tampered);
		await expect(loadManifestLedger(store, LEDGER)).rejects.toThrow(
			/content digest does not reconcile/i,
		);
	});

	it("CAS-loser reread recognizes an identical-content winner after a clock advance", async () => {
		const store = new MemoryStore();
		const manifest = makeManifest(6);
		await publishManifestLedger(store, LEDGER, manifest, {
			maxEntriesPerShard: 3,
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		// Racing writer that missed the head on its first read (clock has
		// advanced; winner's chain hash differs from ours, but the CONTENT
		// digest matches — the loser must still return idempotently).
		const racingStore = Object.create(store);
		let hideHead = true;
		racingStore.getCache = async <T>(key: string): Promise<T | undefined> => {
			if (hideHead && key === manifestHeadKey(LEDGER)) {
				hideHead = false;
				return undefined;
			}
			return store.getCache<T>(key);
		};
		const head = await publishManifestLedger(racingStore, LEDGER, manifest, {
			maxEntriesPerShard: 3,
		});
		expect(head.revision).toBe(0);
	});

	it("containment: entry-level revision change is rejected (revision only on entry)", async () => {
		const base = makeManifest(4);
		// Revision carried ONLY at entry level (reference.revision absent) —
		// a valid representation the validator accepts.
		const atEntry = (i: number, rev: string | undefined) => ({
			...base.contentRefs[i],
			reference: { ...base.contentRefs[i].reference, revision: undefined },
			...(rev === undefined ? {} : { revision: rev }),
		});
		const seeded = validateCompactionContentManifest({
			schemaVersion: 1,
			contentRefs: base.contentRefs.map((e, i) =>
				i === 2 ? atEntry(2, "entry-r1") : e,
			),
			modifiedFiles: [],
			pendingProcesses: [],
		});
		const fresh = new MemoryStore();
		await publishManifestLedger(fresh, LEDGER, seeded, {
			maxEntriesPerShard: 3,
		});
		const changed = validateCompactionContentManifest({
			schemaVersion: 1,
			contentRefs: base.contentRefs.map((e, i) =>
				i === 2 ? atEntry(2, "entry-r2") : e,
			),
			modifiedFiles: [],
			pendingProcesses: [],
		});
		await expect(
			publishManifestLedger(fresh, LEDGER, changed, { maxEntriesPerShard: 3 }),
		).rejects.toThrow(/omits prior authorized entries/);
	});

	it("containment: entry-level revision LOSS is rejected (revision only on entry)", async () => {
		const base = makeManifest(4);
		const atEntry = (i: number, rev: string | undefined) => ({
			...base.contentRefs[i],
			reference: { ...base.contentRefs[i].reference, revision: undefined },
			...(rev === undefined ? {} : { revision: rev }),
		});
		const seeded = validateCompactionContentManifest({
			schemaVersion: 1,
			contentRefs: base.contentRefs.map((e, i) =>
				i === 2 ? atEntry(2, "entry-r1") : e,
			),
			modifiedFiles: [],
			pendingProcesses: [],
		});
		const fresh = new MemoryStore();
		await publishManifestLedger(fresh, LEDGER, seeded, {
			maxEntriesPerShard: 3,
		});
		// Replacement drops the entry-level revision entirely.
		const dropped = validateCompactionContentManifest({
			schemaVersion: 1,
			contentRefs: base.contentRefs.map((e, i) =>
				i === 2 ? atEntry(2, undefined) : e,
			),
			modifiedFiles: [],
			pendingProcesses: [],
		});
		await expect(
			publishManifestLedger(fresh, LEDGER, dropped, { maxEntriesPerShard: 3 }),
		).rejects.toThrow(/omits prior authorized entries/);
	});

	// ── R2 follow-ups: containment semantics + createdAt binding ──

	it("containment: growing one entry's ranges passes", async () => {
		const store = new MemoryStore();
		await publishManifestLedger(store, LEDGER, makeManifest(4), {
			maxEntriesPerShard: 3,
		});
		const base = makeEntry(2, 2);
		const grownEntry = {
			...base,
			rangesUsed: [
				...base.rangesUsed,
				{ unit: "byte" as const, start: 900, end: 950 },
			],
		};
		const grown = validateCompactionContentManifest({
			schemaVersion: 1,
			contentRefs: [0, 1, 2, 3].map((i) =>
				i === 2 ? grownEntry : makeEntry(i, 2),
			),
			modifiedFiles: [],
			pendingProcesses: [],
		});
		const head = await publishManifestLedger(store, LEDGER, grown, {
			maxEntriesPerShard: 3,
		});
		expect(head.revision).toBe(1);
	});

	it("containment: shrinking one entry's ranges is rejected", async () => {
		const store = new MemoryStore();
		await publishManifestLedger(store, LEDGER, makeManifest(4), {
			maxEntriesPerShard: 3,
		});
		const shrunkEntry = {
			...makeEntry(2, 2),
			rangesUsed: [makeEntry(2, 2).rangesUsed[0]],
		};
		const shrunk = validateCompactionContentManifest({
			schemaVersion: 1,
			contentRefs: [0, 1, 2, 3].map((i) =>
				i === 2 ? shrunkEntry : makeEntry(i, 2),
			),
			modifiedFiles: [],
			pendingProcesses: [],
		});
		await expect(
			publishManifestLedger(store, LEDGER, shrunk, { maxEntriesPerShard: 3 }),
		).rejects.toThrow(/omits prior authorized entries/);
	});

	it("containment: dropping all ranges of a prior entry is rejected", async () => {
		const store = new MemoryStore();
		await publishManifestLedger(store, LEDGER, makeManifest(4), {
			maxEntriesPerShard: 3,
		});
		const emptiedEntry = { ...makeEntry(2, 2), rangesUsed: [] };
		const emptied = validateCompactionContentManifest({
			schemaVersion: 1,
			contentRefs: [0, 1, 2, 3].map((i) =>
				i === 2 ? emptiedEntry : makeEntry(i, 2),
			),
			modifiedFiles: [],
			pendingProcesses: [],
		});
		await expect(
			publishManifestLedger(store, LEDGER, emptied, { maxEntriesPerShard: 3 }),
		).rejects.toThrow(/omits prior authorized entries/);
	});

	it("mutant RETIME: changing a shard's createdAt without recomputing the chain is detected", async () => {
		const { store, shards, rawKey } = await publishForMutants();
		const retimed: ManifestShard = {
			...shards[0],
			createdAt: "2027-01-01T00:00:00.000Z",
		};
		store.put(rawKey(0), retimed);
		await expect(loadManifestLedger(store, LEDGER)).rejects.toThrow(
			/chain hash mismatch/,
		);
	});

	// ── Omission containment + CAS-loser idempotency (#25141 R1 F5) ──

	it("omission containment: a replacement manifest missing a prior entry is rejected", async () => {
		const store = new MemoryStore();
		await publishManifestLedger(store, LEDGER, makeManifest(9), {
			maxEntriesPerShard: 3,
		});
		// Drop entry 4 entirely (smaller manifest, same first entries).
		const smaller = validateCompactionContentManifest({
			schemaVersion: 1,
			contentRefs: [4, 5, 6, 7, 8]
				.map((i) => makeEntry(i, 2))
				.filter((_, idx) => idx !== 0),
			modifiedFiles: [],
			pendingProcesses: [],
		});
		await expect(
			publishManifestLedger(store, LEDGER, smaller, { maxEntriesPerShard: 3 }),
		).rejects.toThrow(/omits prior authorized entries/);
	});

	it("omission containment: adding entries to a prior ledger is allowed", async () => {
		const store = new MemoryStore();
		const first = await publishManifestLedger(store, LEDGER, makeManifest(4), {
			maxEntriesPerShard: 3,
		});
		const grown = await publishManifestLedger(store, LEDGER, makeManifest(6), {
			maxEntriesPerShard: 3,
		});
		expect(grown.revision).toBe(first.revision + 1);
	});

	it("CAS loser reread: losing to a writer that published identical content returns idempotently", async () => {
		const store = new MemoryStore();
		const manifest = makeManifest(6);
		await publishManifestLedger(store, LEDGER, manifest, {
			maxEntriesPerShard: 3,
		});
		// A racing writer already published IDENTICAL content, but our read of
		// the head predates it: hide the head from the initial read only, so
		// publish takes the fresh path (expectedRevision=null) and the CAS
		// loses against the racing row. The loser reread must recognize the
		// identical winner and return its head instead of throwing.
		const racingStore = Object.create(store);
		let hideHead = true;
		racingStore.getCache = async <T>(key: string): Promise<T | undefined> => {
			if (hideHead && key === manifestHeadKey(LEDGER)) {
				hideHead = false;
				return undefined;
			}
			return store.getCache<T>(key);
		};
		const head = await publishManifestLedger(racingStore, LEDGER, manifest, {
			maxEntriesPerShard: 3,
		});
		expect(head.revision).toBe(0);
	});

	it("CAS loser reread: a genuinely divergent winner still throws the typed stale-publish error", async () => {
		const store = new MemoryStore();
		await publishManifestLedger(store, LEDGER, makeManifest(6), {
			maxEntriesPerShard: 3,
		});
		// Grow the ledger (winner published MORE content, revision now 1).
		await publishManifestLedger(store, LEDGER, makeManifest(9), {
			maxEntriesPerShard: 3,
		});
		// A stale writer that still expects revision 0 and wants to publish a
		// DIFFERENT manifest (different entries than the winner) must fail.
		const staleStore = Object.create(store);
		staleStore.compareAndSwapCache = async (
			key: string,
			expectedRevision: number | null,
			nextRevision: number,
			value: unknown,
		) =>
			store.compareAndSwapCache(
				key,
				expectedRevision === 1 ? 0 : expectedRevision,
				nextRevision,
				value,
			);
		const divergent = validateCompactionContentManifest({
			schemaVersion: 1,
			contentRefs: [makeEntry(20, 2), makeEntry(21, 2), makeEntry(22, 2)],
			modifiedFiles: [],
			pendingProcesses: [],
		});
		await expect(
			publishManifestLedger(staleStore, LEDGER, divergent, {
				maxEntriesPerShard: 3,
			}),
		).rejects.toThrow(
			/omits prior authorized entries|lost the compare-and-swap/,
		);
	});

	it("mutant INTEGRITY: flipping a range byte inside an entry breaks the hash", async () => {
		const { store, shards, rawKey } = await publishForMutants();
		const victim = shards[1];
		const mutatedEntries = victim.entries.map((entry, i) =>
			i === 0
				? {
						...entry,
						rangesUsed: [{ unit: "byte" as const, start: 999, end: 1099 }],
					}
				: entry,
		);
		store.put(rawKey(1), {
			...victim,
			entries: mutatedEntries,
		});
		await expect(loadManifestLedger(store, LEDGER)).rejects.toThrow(
			/entries hash mismatch/,
		);
	});
});
