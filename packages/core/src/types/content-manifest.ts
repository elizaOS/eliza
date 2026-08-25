/**
 * Defines and validates the content-only archive manifest retained beside an
 * LLM summary. The schema carries opaque native references and exact ranges,
 * never source text, native paths, credentials, or ambient authorization.
 */

import {
	type ContentReference,
	READ_RANGE_UNITS,
	type ReadRangeUnit,
	validateContentReference,
} from "./content";

export const COMPACTION_CONTENT_MANIFEST_SCHEMA_VERSION = 1 as const;
export const COMPACTION_CONTENT_MANIFEST_MAX_BYTES = 256 * 1024;
export const COMPACTION_CONTENT_MANIFEST_MAX_REFERENCES = 256;
export const COMPACTION_CONTENT_MANIFEST_MAX_RANGES_PER_REFERENCE = 64;
export const COMPACTION_CONTENT_MANIFEST_MAX_PENDING_PROCESSES = 128;

export interface CompactionContentRange {
	unit: ReadRangeUnit;
	start: number;
	end: number;
}

export interface CompactionContentEntry {
	reference: ContentReference;
	revision?: string;
	reason: string;
	rangesUsed: CompactionContentRange[];
	lastUsedAt: string;
	retained: boolean;
	expiresAt?: string;
}

export interface CompactionContentManifest {
	schemaVersion: typeof COMPACTION_CONTENT_MANIFEST_SCHEMA_VERSION;
	contentRefs: CompactionContentEntry[];
	modifiedFiles: Array<{
		reference: ContentReference;
		revision?: string;
	}>;
	pendingProcesses: Array<{
		id: string;
		outputReference?: ContentReference;
		offset?: number;
	}>;
}

const MANIFEST_KEYS = new Set([
	"schemaVersion",
	"contentRefs",
	"modifiedFiles",
	"pendingProcesses",
]);
const ENTRY_KEYS = new Set([
	"reference",
	"revision",
	"reason",
	"rangesUsed",
	"lastUsedAt",
	"retained",
	"expiresAt",
]);
const RANGE_KEYS = new Set(["unit", "start", "end"]);
const MODIFIED_FILE_KEYS = new Set(["reference", "revision"]);
const PENDING_PROCESS_KEYS = new Set(["id", "outputReference", "offset"]);
const RANGE_UNITS = new Set<string>(READ_RANGE_UNITS);
const SAFE_ID = /^[A-Za-z0-9._:~-]{1,256}$/u;

function record(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
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
		throw new TypeError(
			`${label} contains unsupported field(s): ${unknown.join(", ")}`,
		);
	}
}

function nonnegative(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${label} must be a nonnegative safe integer`);
	}
	return value;
}

function nonempty(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${label} must be a nonempty string`);
	}
	return value;
}

function timestamp(value: unknown, label: string): string {
	const text = nonempty(value, label);
	const epoch = Date.parse(text);
	if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== text) {
		throw new TypeError(`${label} must be an ISO-8601 UTC timestamp`);
	}
	return text;
}

/** Strictly validate an untrusted persisted content manifest. */
export function validateCompactionContentManifest(
	value: unknown,
): CompactionContentManifest {
	const input = record(value, "content manifest");
	exactKeys(input, MANIFEST_KEYS, "content manifest");
	if (input.schemaVersion !== COMPACTION_CONTENT_MANIFEST_SCHEMA_VERSION) {
		throw new TypeError("content manifest schemaVersion is unsupported");
	}
	if (!Array.isArray(input.contentRefs)) {
		throw new TypeError("content manifest contentRefs must be an array");
	}
	if (input.contentRefs.length > COMPACTION_CONTENT_MANIFEST_MAX_REFERENCES) {
		throw new TypeError("content manifest has too many references");
	}
	const seenReferences = new Map<string, string | undefined>();
	const contentRefs = input.contentRefs.map((rawEntry, entryIndex) => {
		const entry = record(rawEntry, `contentRefs[${entryIndex}]`);
		exactKeys(entry, ENTRY_KEYS, `contentRefs[${entryIndex}]`);
		const reference = validateContentReference(entry.reference);
		const revision =
			entry.revision === undefined
				? reference.revision
				: nonempty(entry.revision, `contentRefs[${entryIndex}].revision`);
		if (
			reference.revision !== undefined &&
			revision !== undefined &&
			reference.revision !== revision
		) {
			throw new TypeError("content manifest reference revision mismatch");
		}
		const key = `${reference.kind}\u0000${reference.ref}`;
		if (seenReferences.has(key)) {
			const priorRevision = seenReferences.get(key);
			if (priorRevision !== revision) {
				throw new TypeError("content manifest contains conflicting revisions");
			}
			throw new TypeError("content manifest contains a duplicate reference");
		}
		seenReferences.set(key, revision);
		if (!Array.isArray(entry.rangesUsed)) {
			throw new TypeError(
				`contentRefs[${entryIndex}].rangesUsed must be an array`,
			);
		}
		if (
			entry.rangesUsed.length >
			COMPACTION_CONTENT_MANIFEST_MAX_RANGES_PER_REFERENCE
		) {
			throw new TypeError("content manifest entry has too many ranges");
		}
		const rangesUsed = entry.rangesUsed.map((rawRange, rangeIndex) => {
			const range = record(
				rawRange,
				`contentRefs[${entryIndex}].rangesUsed[${rangeIndex}]`,
			);
			exactKeys(range, RANGE_KEYS, "content manifest range");
			if (typeof range.unit !== "string" || !RANGE_UNITS.has(range.unit)) {
				throw new TypeError("content manifest range unit is unsupported");
			}
			const start = nonnegative(range.start, "content manifest range.start");
			const end = nonnegative(range.end, "content manifest range.end");
			if (start > end)
				throw new TypeError("content manifest range start exceeds end");
			return { unit: range.unit as ReadRangeUnit, start, end };
		});
		if (typeof entry.retained !== "boolean") {
			throw new TypeError(
				`contentRefs[${entryIndex}].retained must be boolean`,
			);
		}
		return {
			reference,
			...(revision ? { revision } : {}),
			reason: nonempty(entry.reason, `contentRefs[${entryIndex}].reason`),
			rangesUsed,
			lastUsedAt: timestamp(
				entry.lastUsedAt,
				`contentRefs[${entryIndex}].lastUsedAt`,
			),
			retained: entry.retained,
			...(entry.expiresAt === undefined
				? {}
				: {
						expiresAt: timestamp(
							entry.expiresAt,
							`contentRefs[${entryIndex}].expiresAt`,
						),
					}),
		};
	});
	if (!Array.isArray(input.modifiedFiles)) {
		throw new TypeError("content manifest modifiedFiles must be an array");
	}
	if (input.modifiedFiles.length > COMPACTION_CONTENT_MANIFEST_MAX_REFERENCES) {
		throw new TypeError("content manifest has too many modified files");
	}
	const seenModifiedFiles = new Map<string, string | undefined>();
	const modifiedFiles = input.modifiedFiles.map((raw, index) => {
		const item = record(raw, `modifiedFiles[${index}]`);
		exactKeys(item, MODIFIED_FILE_KEYS, `modifiedFiles[${index}]`);
		const reference = validateContentReference(item.reference);
		if (reference.kind !== "file") {
			throw new TypeError("modifiedFiles references must have kind=file");
		}
		const revision =
			item.revision === undefined
				? reference.revision
				: nonempty(item.revision, `modifiedFiles[${index}].revision`);
		if (
			reference.revision !== undefined &&
			revision !== undefined &&
			reference.revision !== revision
		) {
			throw new TypeError("modified file reference revision mismatch");
		}
		const key = `${reference.kind}\u0000${reference.ref}`;
		if (seenModifiedFiles.has(key)) {
			const priorRevision = seenModifiedFiles.get(key);
			if (priorRevision !== revision) {
				throw new TypeError("modified files contain conflicting revisions");
			}
			throw new TypeError("modified files contain a duplicate reference");
		}
		seenModifiedFiles.set(key, revision);
		return { reference, ...(revision ? { revision } : {}) };
	});
	if (!Array.isArray(input.pendingProcesses)) {
		throw new TypeError("content manifest pendingProcesses must be an array");
	}
	if (
		input.pendingProcesses.length >
		COMPACTION_CONTENT_MANIFEST_MAX_PENDING_PROCESSES
	) {
		throw new TypeError("content manifest has too many pending processes");
	}
	const pendingProcesses = input.pendingProcesses.map((raw, index) => {
		const item = record(raw, `pendingProcesses[${index}]`);
		exactKeys(item, PENDING_PROCESS_KEYS, `pendingProcesses[${index}]`);
		const id = nonempty(item.id, `pendingProcesses[${index}].id`);
		if (!SAFE_ID.test(id))
			throw new TypeError("pending process id is not opaque");
		return {
			id,
			...(item.outputReference === undefined
				? {}
				: { outputReference: validateContentReference(item.outputReference) }),
			...(item.offset === undefined
				? {}
				: { offset: nonnegative(item.offset, "pending process offset") }),
		};
	});
	const manifest: CompactionContentManifest = {
		schemaVersion: COMPACTION_CONTENT_MANIFEST_SCHEMA_VERSION,
		contentRefs,
		modifiedFiles,
		pendingProcesses,
	};
	if (
		new TextEncoder().encode(JSON.stringify(manifest)).byteLength >
		COMPACTION_CONTENT_MANIFEST_MAX_BYTES
	) {
		throw new TypeError("content manifest exceeds its serialized byte bound");
	}
	return manifest;
}
