/**
 * Defines the durable shard envelope and restart-safe head for the
 * progressive-content continuity ledger (issue #25141). Shards are ordered,
 * immutable, hash-chained slices of a CompactionContentManifest; the head is a
 * compare-and-swap publication token. Validation is strict: unknown fields,
 * out-of-bound values, and broken chain invariants throw so persisted bytes can
 * never be silently accepted.
 */

import { ElizaError } from "../errors";
import {
	type CompactionContentEntry,
	validateCompactionContentManifest,
} from "./content-manifest";

export const CONTENT_MANIFEST_SHARD_SCHEMA_VERSION = 1 as const;
export const CONTENT_MANIFEST_HEAD_SCHEMA_VERSION = 1 as const;
/** Hard shard record ceiling from the frozen v1 manifest bounds. */
export const CONTENT_MANIFEST_SHARD_MAX_ENTRIES = 256 as const;
/** Canonical-JSON byte ceiling per shard record (mirrors manifest 256 KiB). */
export const CONTENT_MANIFEST_SHARD_MAX_BYTES = 256 * 1024;
/** Upper bound on shards in one ledger traversal; guards unbounded reads. */
export const CONTENT_MANIFEST_LEDGER_MAX_SHARDS = 1024 as const;

export interface ManifestShard {
	schemaVersion: typeof CONTENT_MANIFEST_SHARD_SCHEMA_VERSION;
	ledgerId: string;
	/** 0-based ordinal; strictly increasing across the ledger. */
	sequence: number;
	entries: CompactionContentEntry[];
	entryCount: number;
	/** Canonical-JSON byte length of this shard record. */
	byteLength: number;
	/** sha256 hex over the canonical serialization of `entries`. */
	entriesSha256: string;
	/** Chain link: entries-hash of the sequence-1 shard; absent on sequence 0. */
	prevSha256?: string;
	/** Rollover link: sequence of the next shard; absent on the tail. */
	nextSequence?: number;
	createdAt: string;
}

export interface ManifestHead {
	schemaVersion: typeof CONTENT_MANIFEST_HEAD_SCHEMA_VERSION;
	ledgerId: string;
	/** First shard sequence; traversal always starts at zero today. */
	headSequence: number;
	/**
	 * Unique publication generation addressing this head's shard rows. Shard
	 * keys embed it, so a concurrent writer that loses the head CAS can never
	 * overwrite the winning generation's chain.
	 */
	shardGeneration: string;
	shardCount: number;
	totalEntries: number;
	totalRanges: number;
	/** Rolling chain hash: entriesSha256 of the tail shard. */
	ledgerSha256: string;
	/** Monotonic compare-and-swap token for head publication. */
	revision: number;
	updatedAt: string;
}

const SHARD_KEYS = new Set([
	"schemaVersion",
	"ledgerId",
	"sequence",
	"entries",
	"entryCount",
	"byteLength",
	"entriesSha256",
	"prevSha256",
	"nextSequence",
	"createdAt",
]);
const HEAD_KEYS = new Set([
	"schemaVersion",
	"ledgerId",
	"headSequence",
	"shardGeneration",
	"shardCount",
	"totalEntries",
	"totalRanges",
	"ledgerSha256",
	"revision",
	"updatedAt",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const LEDGER_ID_PATTERN = /^[A-Za-z0-9._:~:-]{1,256}$/u;

export class ContentManifestIntegrityError extends ElizaError {
	constructor(
		message: string,
		context?: Record<string, unknown>,
		cause?: unknown,
	) {
		super(message, {
			code: "CONTENT_MANIFEST_INTEGRITY",
			context,
			cause,
		});
	}
}

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new ContentManifestIntegrityError(`${label} must be an object`, {
			part: label,
		});
	}
	return value as Record<string, unknown>;
}

function exactKeys(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
	label: string,
): void {
	const unknown = Object.keys(value).filter((key) => !allowed.has(key));
	if (unknown.length > 0) {
		throw new ContentManifestIntegrityError(
			`${label} contains unsupported field(s): ${unknown.join(", ")}`,
			{ part: label, fields: unknown },
		);
	}
}

function nonnegativeSafeInteger(
	value: unknown,
	label: string,
	field: string,
): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new ContentManifestIntegrityError(
			`${label}.${field} must be a nonnegative safe integer`,
			{ part: label, field },
		);
	}
	return value;
}

function isoTimestamp(value: unknown, label: string, field: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ContentManifestIntegrityError(
			`${label}.${field} must be an ISO-8601 UTC timestamp string`,
			{ part: label, field },
		);
	}
	const epoch = Date.parse(value);
	if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
		throw new ContentManifestIntegrityError(
			`${label}.${field} must be an ISO-8601 UTC timestamp`,
			{ part: label, field },
		);
	}
	return value;
}

function sha256Hex(value: unknown, label: string, field: string): string {
	if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
		throw new ContentManifestIntegrityError(
			`${label}.${field} must be a lowercase sha256 hex digest`,
			{ part: label, field },
		);
	}
	return value;
}

function ledgerIdString(value: unknown): string {
	if (typeof value !== "string" || !LEDGER_ID_PATTERN.test(value)) {
		throw new ContentManifestIntegrityError(
			"Manifest ledgerId must match the opaque ledger id pattern",
			{ part: "ledgerId" },
		);
	}
	return value;
}

/**
 * Strictly validate an untrusted persisted manifest shard. Re-validates every
 * entry through the frozen v1 manifest validator so no weakened entry shape can
 * enter the ledger through the shard envelope.
 */
export function validateManifestShard(value: unknown): ManifestShard {
	const input = record(value, "manifest shard");
	exactKeys(input, SHARD_KEYS, "manifest shard");
	if (input.schemaVersion !== CONTENT_MANIFEST_SHARD_SCHEMA_VERSION) {
		throw new ContentManifestIntegrityError(
			"Manifest shard schema version is unsupported",
			{ part: "schemaVersion", value: input.schemaVersion },
		);
	}
	const ledgerId = ledgerIdString(input.ledgerId);
	const sequence = nonnegativeSafeInteger(
		input.sequence,
		"manifest shard",
		"sequence",
	);
	if (!Array.isArray(input.entries)) {
		throw new ContentManifestIntegrityError(
			"Manifest shard entries must be an array",
			{ part: "entries" },
		);
	}
	if (input.entries.length > CONTENT_MANIFEST_SHARD_MAX_ENTRIES) {
		throw new ContentManifestIntegrityError(
			"Manifest shard exceeds the entry ceiling",
			{
				part: "entries",
				entryCount: input.entries.length,
				maxEntries: CONTENT_MANIFEST_SHARD_MAX_ENTRIES,
			},
		);
	}
	// Route entries through the frozen validator: it rejects unknown fields,
	// unsafe references, revision conflicts, and bound violations per entry.
	const validated = validateCompactionContentManifest({
		schemaVersion: 1,
		contentRefs: input.entries as unknown[],
		modifiedFiles: [],
		pendingProcesses: [],
	});
	const entries = validated.contentRefs;
	const entryCount = nonnegativeSafeInteger(
		input.entryCount,
		"manifest shard",
		"entryCount",
	);
	if (entryCount !== entries.length) {
		throw new ContentManifestIntegrityError(
			"Manifest shard entryCount does not match entries length",
			{ part: "entryCount", entryCount, actual: entries.length },
		);
	}
	const byteLength = nonnegativeSafeInteger(
		input.byteLength,
		"manifest shard",
		"byteLength",
	);
	if (byteLength > CONTENT_MANIFEST_SHARD_MAX_BYTES) {
		throw new ContentManifestIntegrityError(
			"Manifest shard exceeds the byte ceiling",
			{
				part: "byteLength",
				byteLength,
				maxBytes: CONTENT_MANIFEST_SHARD_MAX_BYTES,
			},
		);
	}
	const entriesSha256 = sha256Hex(
		input.entriesSha256,
		"manifest shard",
		"entriesSha256",
	);
	if (sequence === 0) {
		if (input.prevSha256 !== undefined) {
			throw new ContentManifestIntegrityError(
				"Manifest shard sequence 0 must not carry a prevSha256 chain link",
				{ part: "prevSha256", sequence },
			);
		}
	} else {
		sha256Hex(input.prevSha256, "manifest shard", "prevSha256");
	}
	if (input.nextSequence !== undefined) {
		if (input.nextSequence !== sequence + 1) {
			throw new ContentManifestIntegrityError(
				"Manifest shard nextSequence must be exactly sequence + 1",
				{ part: "nextSequence", nextSequence: input.nextSequence, sequence },
			);
		}
	}
	const createdAt = isoTimestamp(
		input.createdAt,
		"manifest shard",
		"createdAt",
	);
	return {
		schemaVersion: CONTENT_MANIFEST_SHARD_SCHEMA_VERSION,
		ledgerId,
		sequence,
		entries,
		entryCount,
		byteLength,
		entriesSha256,
		...(input.prevSha256 === undefined
			? {}
			: { prevSha256: input.prevSha256 as string }),
		...(input.nextSequence === undefined
			? {}
			: { nextSequence: input.nextSequence as number }),
		createdAt,
	};
}

/** Strictly validate an untrusted persisted manifest ledger head. */
export function validateManifestHead(value: unknown): ManifestHead {
	const input = record(value, "manifest head");
	exactKeys(input, HEAD_KEYS, "manifest head");
	if (input.schemaVersion !== CONTENT_MANIFEST_HEAD_SCHEMA_VERSION) {
		throw new ContentManifestIntegrityError(
			"Manifest head schema version is unsupported",
			{ part: "schemaVersion", value: input.schemaVersion },
		);
	}
	const ledgerId = ledgerIdString(input.ledgerId);
	const shardGeneration = ledgerIdString(input.shardGeneration);
	const headSequence = nonnegativeSafeInteger(
		input.headSequence,
		"manifest head",
		"headSequence",
	);
	const shardCount = nonnegativeSafeInteger(
		input.shardCount,
		"manifest head",
		"shardCount",
	);
	if (shardCount > CONTENT_MANIFEST_LEDGER_MAX_SHARDS) {
		throw new ContentManifestIntegrityError(
			"Manifest head shardCount exceeds the traversal bound",
			{
				part: "shardCount",
				shardCount,
				maxShards: CONTENT_MANIFEST_LEDGER_MAX_SHARDS,
			},
		);
	}
	const totalEntries = nonnegativeSafeInteger(
		input.totalEntries,
		"manifest head",
		"totalEntries",
	);
	const totalRanges = nonnegativeSafeInteger(
		input.totalRanges,
		"manifest head",
		"totalRanges",
	);
	const ledgerSha256 = sha256Hex(
		input.ledgerSha256,
		"manifest head",
		"ledgerSha256",
	);
	const revision = nonnegativeSafeInteger(
		input.revision,
		"manifest head",
		"revision",
	);
	const updatedAt = isoTimestamp(input.updatedAt, "manifest head", "updatedAt");
	if (shardCount === 0) {
		if (headSequence !== 0 || totalEntries !== 0 || totalRanges !== 0) {
			throw new ContentManifestIntegrityError(
				"Empty manifest head must carry zeroed reconciliation totals",
				{ part: "shardCount", headSequence, totalEntries, totalRanges },
			);
		}
	} else if (headSequence !== 0) {
		throw new ContentManifestIntegrityError(
			"Manifest head must point at the first shard (sequence 0)",
			{ part: "headSequence", headSequence },
		);
	}
	return {
		schemaVersion: CONTENT_MANIFEST_HEAD_SCHEMA_VERSION,
		ledgerId,
		headSequence,
		shardGeneration,
		shardCount,
		totalEntries,
		totalRanges,
		ledgerSha256,
		revision,
		updatedAt,
	};
}
