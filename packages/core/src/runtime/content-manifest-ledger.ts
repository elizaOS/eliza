/**
 * Content-manifest ledger store: lossless ordered shard rollover, idempotent
 * compare-and-swap publication, and restart-safe verified traversal for the
 * progressive-content continuity contract (#25141). Shards and the head are
 * persisted through the database adapter cache API (existing memory/database
 * domain); every read is strictly re-validated so tampered or corrupt bytes
 * fail with typed integrity errors instead of silent acceptance.
 */

import { createHash, randomBytes } from "node:crypto";
import { ElizaError } from "../errors";
import type {
	CompactionContentEntry,
	CompactionContentManifest,
} from "../types/content-manifest";
import {
	CONTENT_MANIFEST_LEDGER_MAX_SHARDS,
	CONTENT_MANIFEST_SHARD_MAX_BYTES,
	CONTENT_MANIFEST_SHARD_MAX_ENTRIES,
	ContentManifestIntegrityError,
	type ManifestHead,
	type ManifestShard,
	validateManifestHead,
	validateManifestShard,
} from "../types/content-manifest-shards";

/** Minimal adapter surface the ledger needs; satisfied by IDatabaseAdapter. */
export interface ContentManifestLedgerStore {
	getCache<T>(key: string): Promise<T | undefined>;
	setCache<T>(key: string, value: T): Promise<boolean>;
	getCaches<T>(keys: string[]): Promise<Map<string, T>>;
	setCaches<T>(entries: Array<{ key: string; value: T }>): Promise<boolean>;
	/** Optional best-effort cleanup of inert superseded shard rows. */
	deleteCaches?(keys: string[]): Promise<boolean>;
	compareAndSwapCache<T>(
		key: string,
		expectedRevision: number | null,
		nextRevision: number,
		value: T,
	): Promise<boolean>;
}

export const CONTENT_MANIFEST_SHARD_KEY_PREFIX = "content-manifest-shard:";
export const CONTENT_MANIFEST_HEAD_KEY_PREFIX = "content-manifest-head:";

/**
 * Shard rows are generation-addressed: the publishing head's unique shard
 * generation is part of the key. A losing concurrent writer's shard bytes can
 * therefore never overwrite the winning generation's chain, and superseded
 * generations are inert until their head is replaced (then best-effort
 * cleaned).
 */
export function manifestShardKey(
	ledgerId: string,
	generation: string,
	sequence: number,
): string {
	return `${CONTENT_MANIFEST_SHARD_KEY_PREFIX}${ledgerId}:${generation}:${sequence}`;
}

export function manifestHeadKey(ledgerId: string): string {
	return `${CONTENT_MANIFEST_HEAD_KEY_PREFIX}${ledgerId}`;
}

/**
 * Canonical serialization for hashing: JSON of a validated object.
 * Validators reconstruct objects with literal key order and skip `undefined`,
 * so stringify of a validated value is byte-stable.
 */
export function canonicalShardBytes(shard: ManifestShard): string {
	return JSON.stringify(shard);
}

export function hashEntries(entries: CompactionContentEntry[]): string {
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function entryCountOf(entries: CompactionContentEntry[]): number {
	return entries.length;
}

function rangeCountOf(entries: CompactionContentEntry[]): number {
	return entries.reduce((sum, entry) => sum + entry.rangesUsed.length, 0);
}

export interface BuildShardsOptions {
	ledgerId: string;
	/** Split threshold for entries per shard (ceiling enforced regardless). */
	maxEntriesPerShard?: number;
	/** Split threshold for canonical shard bytes (ceiling enforced regardless). */
	maxBytesPerShard?: number;
	createdAt?: string;
}

export interface BuiltLedger {
	shards: ManifestShard[];
	head: ManifestHead;
}

/**
 * Split a manifest into ordered hash-chained shards, rolling over at entry
 * count or canonical byte bounds without ever dropping, reordering, or
 * deduplicating away an entry. A single entry larger than the byte bound still
 * occupies its own shard: rollover is lossless, not truncating.
 */
export function buildManifestShards(
	manifest: CompactionContentManifest,
	options: BuildShardsOptions,
): BuiltLedger {
	const maxEntries =
		options.maxEntriesPerShard ?? CONTENT_MANIFEST_SHARD_MAX_ENTRIES;
	const maxBytes = options.maxBytesPerShard ?? CONTENT_MANIFEST_SHARD_MAX_BYTES;
	if (maxEntries > CONTENT_MANIFEST_SHARD_MAX_ENTRIES) {
		throw new ElizaError(
			"Manifest shard entry bound exceeds the schema ceiling",
			{
				code: "CONTENT_MANIFEST_SHARD_BOUND_INVALID",
				context: { maxEntries, ceiling: CONTENT_MANIFEST_SHARD_MAX_ENTRIES },
			},
		);
	}
	if (maxBytes > CONTENT_MANIFEST_SHARD_MAX_BYTES) {
		throw new ElizaError(
			"Manifest shard byte bound exceeds the schema ceiling",
			{
				code: "CONTENT_MANIFEST_SHARD_BOUND_INVALID",
				context: { maxBytes, ceiling: CONTENT_MANIFEST_SHARD_MAX_BYTES },
			},
		);
	}
	const createdAt = options.createdAt ?? new Date().toISOString();
	const entries = manifest.contentRefs;
	const shards: ManifestShard[] = [];
	let current: CompactionContentEntry[] = [];
	/**
	 * Measure the canonical bytes a shard record carrying `draft` entries would
	 * occupy, including the envelope fields (and the forward link it will gain
	 * when a later shard follows). Packing must bound the full record, not the
	 * bare entry sum, or the persisted record can exceed the byte ceiling.
	 */
	const draftBytes = (draft: CompactionContentEntry[]): number => {
		const sequence = shards.length;
		const probe: ManifestShard = {
			schemaVersion: 1,
			ledgerId: options.ledgerId,
			sequence,
			entries: draft,
			entryCount: draft.length,
			byteLength: 0,
			entriesSha256: hashEntries(draft),
			...(sequence === 0 ? {} : { prevSha256: "0".repeat(64) }),
			nextSequence: sequence + 1,
			createdAt,
		};
		return Buffer.byteLength(canonicalShardBytes(probe), "utf8");
	};
	const flush = () => {
		if (current.length === 0) return;
		const sequence = shards.length;
		const entriesSha256 = hashEntries(current);
		const prev = shards[shards.length - 1];
		const shard: ManifestShard = {
			schemaVersion: 1,
			ledgerId: options.ledgerId,
			sequence,
			entries: current,
			entryCount: current.length,
			byteLength: 0,
			entriesSha256,
			...(sequence === 0 ? {} : { prevSha256: prev.entriesSha256 }),
			createdAt,
		};
		// Link the previous tail forward before appending.
		if (prev) {
			prev.nextSequence = sequence;
		}
		shard.byteLength = Buffer.byteLength(canonicalShardBytes(shard), "utf8");
		shards.push(shard);
		current = [];
	};
	for (const entry of entries) {
		if (
			current.length > 0 &&
			(current.length >= maxEntries ||
				draftBytes([...current, entry]) > maxBytes)
		) {
			flush();
		}
		current.push(entry);
	}
	flush();
	if (shards.length > CONTENT_MANIFEST_LEDGER_MAX_SHARDS) {
		throw new ElizaError("Manifest ledger exceeds the shard traversal bound", {
			code: "CONTENT_MANIFEST_LEDGER_TOO_LARGE",
			context: { shardCount: shards.length },
		});
	}
	const tail = shards[shards.length - 1];
	const head: ManifestHead = {
		schemaVersion: 1,
		ledgerId: options.ledgerId,
		headSequence: 0,
		shardGeneration: randomShardGeneration(),
		shardCount: shards.length,
		totalEntries: entryCountOf(entries),
		totalRanges: rangeCountOf(entries),
		ledgerSha256: tail.entriesSha256,
		revision: 0,
		updatedAt: createdAt,
	};
	return { shards, head };
}

/** Random 128-bit hex token making each publication's shard rows unique. */
function randomShardGeneration(): string {
	return randomBytes(16).toString("hex");
}

/**
 * Idempotent, compare-and-swap-safe publication: shards are content-hashed and
 * written first (re-upserting identical bytes is harmless); the head is
 * published last with a revision CAS so a concurrent writer either observes an
 * identical ledger (no-op) or loses with a typed stale-publish error.
 */
export async function publishManifestLedger(
	store: ContentManifestLedgerStore,
	ledgerId: string,
	manifest: CompactionContentManifest,
	options?: Omit<BuildShardsOptions, "ledgerId">,
): Promise<ManifestHead> {
	const { shards, head } = buildManifestShards(manifest, {
		ledgerId,
		...options,
	});
	const existingHead = await store.getCache<unknown>(manifestHeadKey(ledgerId));
	let expectedRevision: number | null = null;
	let supersededGeneration: string | null = null;
	if (existingHead !== undefined) {
		const prior = validateManifestHead(existingHead);
		// Idempotency: same chain hash + same totals => the ledger is already
		// published; re-publishing identical bytes must be a no-op.
		if (
			prior.ledgerSha256 === head.ledgerSha256 &&
			prior.totalEntries === head.totalEntries &&
			prior.totalRanges === head.totalRanges
		) {
			return prior;
		}
		expectedRevision = prior.revision;
		supersededGeneration = prior.shardGeneration;
	}
	await store.setCaches(
		shards.map((shard) => ({
			key: manifestShardKey(ledgerId, head.shardGeneration, shard.sequence),
			value: shard,
		})),
	);
	const nextHead: ManifestHead = {
		...head,
		revision: (expectedRevision ?? -1) + 1,
		updatedAt: new Date().toISOString(),
	};
	const swapped = await store.compareAndSwapCache(
		manifestHeadKey(ledgerId),
		expectedRevision,
		nextHead.revision,
		nextHead,
	);
	if (!swapped) {
		// error-policy:J6 the losing writer's own shard rows are inert
		// (generation-addressed) and best-effort removed; failure to clean is
		// debug-only, never a reason to fail the typed stale-publish error.
		await store.deleteCaches?.(
			shards.map((shard) =>
				manifestShardKey(ledgerId, head.shardGeneration, shard.sequence),
			),
		);
		throw new ElizaError(
			"Manifest ledger publication lost the compare-and-swap race",
			{
				code: "CONTENT_MANIFEST_STALE_PUBLISH",
				context: { ledgerId, expectedRevision },
			},
		);
	}
	if (supersededGeneration !== null) {
		// error-policy:J6 superseded generation's rows are unreachable through
		// the new head; best-effort cleanup, debug on failure.
		await store.deleteCaches?.(
			Array.from({ length: shards.length }, (_, sequence) =>
				manifestShardKey(ledgerId, supersededGeneration as string, sequence),
			),
		);
	}
	return nextHead;
}

export interface LoadedLedger {
	head: ManifestHead;
	shards: ManifestShard[];
	entries: CompactionContentEntry[];
}

/**
 * Load and fully verify a ledger: head validation, ordered traversal from
 * sequence 0, per-shard strict validation, hash-chain and next-link
 * continuity, duplicate/reorder/cycle detection via sequence monotonicity and
 * a cross-shard entry-key set, and reconciliation against head totals. Any
 * mismatch throws a typed integrity error — never a silent accept.
 */
export async function loadManifestLedger(
	store: ContentManifestLedgerStore,
	ledgerId: string,
): Promise<LoadedLedger> {
	const rawHead = await store.getCache<unknown>(manifestHeadKey(ledgerId));
	if (rawHead === undefined) {
		throw new ElizaError("Manifest ledger head is missing", {
			code: "CONTENT_MANIFEST_HEAD_MISSING",
			context: { ledgerId },
		});
	}
	const head = validateManifestHead(rawHead);
	const keys: string[] = [];
	for (let sequence = 0; sequence < head.shardCount; sequence++) {
		keys.push(manifestShardKey(ledgerId, head.shardGeneration, sequence));
	}
	const rawShards = await store.getCaches<unknown>(keys);
	const shards: ManifestShard[] = [];
	const entries: CompactionContentEntry[] = [];
	const seenEntryKeys = new Set<string>();
	for (let sequence = 0; sequence < head.shardCount; sequence++) {
		const raw = rawShards.get(
			manifestShardKey(ledgerId, head.shardGeneration, sequence),
		);
		if (raw === undefined) {
			throw new ContentManifestIntegrityError(
				"Manifest shard missing during traversal",
				{ ledgerId, sequence },
			);
		}
		const shard = validateManifestShard(raw);
		if (shard.ledgerId !== ledgerId || shard.sequence !== sequence) {
			throw new ContentManifestIntegrityError(
				"Manifest shard identity does not match its position",
				{
					ledgerId,
					sequence,
					shardLedgerId: shard.ledgerId,
					shardSequence: shard.sequence,
				},
			);
		}
		if (hashEntries(shard.entries) !== shard.entriesSha256) {
			throw new ContentManifestIntegrityError(
				"Manifest shard entries hash mismatch",
				{ ledgerId, sequence },
			);
		}
		if (sequence > 0) {
			if (shard.prevSha256 !== shards[sequence - 1].entriesSha256) {
				throw new ContentManifestIntegrityError(
					"Manifest shard chain link mismatch",
					{ ledgerId, sequence },
				);
			}
			if (shards[sequence - 1].nextSequence !== sequence) {
				throw new ContentManifestIntegrityError(
					"Manifest shard next-link discontinuity",
					{ ledgerId, sequence },
				);
			}
		} else if (shard.prevSha256 !== undefined) {
			throw new ContentManifestIntegrityError(
				"Manifest shard sequence 0 must not carry a chain link",
				{ ledgerId },
			);
		}
		const isTail = sequence === head.shardCount - 1;
		if (isTail && shard.nextSequence !== undefined) {
			throw new ContentManifestIntegrityError(
				"Manifest tail shard must not point past the ledger",
				{ ledgerId, sequence, nextSequence: shard.nextSequence },
			);
		}
		for (const entry of shard.entries) {
			const key = `${entry.reference.kind}\u0000${entry.reference.ref}`;
			if (seenEntryKeys.has(key)) {
				throw new ContentManifestIntegrityError(
					"Manifest ledger contains a duplicate entry",
					{
						ledgerId,
						sequence,
						kind: entry.reference.kind,
						ref: entry.reference.ref,
					},
				);
			}
			seenEntryKeys.add(key);
			entries.push(entry);
		}
		shards.push(shard);
	}
	if (entries.length !== head.totalEntries) {
		throw new ContentManifestIntegrityError(
			"Manifest ledger entry total does not reconcile with the head",
			{ ledgerId, total: entries.length, expected: head.totalEntries },
		);
	}
	const totalRanges = rangeCountOf(entries);
	if (totalRanges !== head.totalRanges) {
		throw new ContentManifestIntegrityError(
			"Manifest ledger range total does not reconcile with the head",
			{ ledgerId, total: totalRanges, expected: head.totalRanges },
		);
	}
	const tail = shards[shards.length - 1];
	if (tail.entriesSha256 !== head.ledgerSha256) {
		throw new ContentManifestIntegrityError(
			"Manifest ledger chain hash does not reconcile with the head",
			{ ledgerId },
		);
	}
	return { head, shards, entries };
}
