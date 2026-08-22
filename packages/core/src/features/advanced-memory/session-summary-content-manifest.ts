/**
 * Preserves validated progressive-content manifests beside rolling session
 * summaries and renders a bounded, body-free reference index for prompt context.
 * This is a persistence seam only: it does not assert that compaction occurred.
 */

import type { ContentReference } from "../../types/content.ts";
import {
	COMPACTION_CONTENT_MANIFEST_MAX_BYTES,
	COMPACTION_CONTENT_MANIFEST_MAX_PENDING_PROCESSES,
	COMPACTION_CONTENT_MANIFEST_MAX_RANGES_PER_REFERENCE,
	COMPACTION_CONTENT_MANIFEST_MAX_REFERENCES,
	type CompactionContentEntry,
	type CompactionContentManifest,
	type CompactionContentRange,
	validateCompactionContentManifest,
} from "../../types/content-manifest.ts";
import type { Memory } from "../../types/memory.ts";
import type { JsonValue } from "../../types/primitives.ts";

export const SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY =
	"elizaos:progressiveContent";
export const SESSION_SUMMARY_PROGRESSIVE_CONTENT_SCHEMA_VERSION = 1 as const;
const ENVELOPE_KEYS = new Set(["schemaVersion", "contentManifest", "rollover"]);
const ROLLOVER_KEYS = new Set([
	"omittedReferences",
	"omittedRanges",
	"omittedModifiedFiles",
	"omittedPendingProcesses",
]);
const DEFAULT_MAX_RENDERED_REFERENCES = 12;
const DEFAULT_MAX_RENDERED_RANGES = 8;
const DEFAULT_MAX_RENDERED_MODIFIED_FILES = 12;
const DEFAULT_MAX_RENDERED_PENDING_PROCESSES = 12;
const DEFAULT_MAX_RENDERED_CHARACTERS = 4096;
const RESTART_RESOLVABLE_CONTENT_REFERENCE_KINDS = new Set([
	"document",
	"memory",
]);
const UUID_REFERENCE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_REVISION = /^[A-Za-z0-9._:~-]{1,256}$/u;

/** True only when a fresh runtime can address the native resolver directly. */
export function isRestartResolvableContentReference(
	reference: ContentReference,
): boolean {
	if (!RESTART_RESOLVABLE_CONTENT_REFERENCE_KINDS.has(reference.kind)) {
		return false;
	}
	const prefix = `${reference.kind}:`;
	return (
		reference.ref.startsWith(prefix) &&
		UUID_REFERENCE.test(reference.ref.slice(prefix.length)) &&
		(reference.revision === undefined || SAFE_REVISION.test(reference.revision))
	);
}

function restartResolvableManifest(value: unknown): CompactionContentManifest {
	const manifest = validateCompactionContentManifest(value);
	return validateCompactionContentManifest({
		...manifest,
		contentRefs: manifest.contentRefs.filter((entry) => {
			const revision = entry.revision ?? entry.reference.revision;
			return (
				isRestartResolvableContentReference(entry.reference) &&
				(revision === undefined || SAFE_REVISION.test(revision))
			);
		}),
		// File paths and process outputs do not yet have fresh-runtime native
		// resolver coordinates. Keep them out of durable summary metadata.
		modifiedFiles: [],
		pendingProcesses: [],
	});
}

export interface SessionSummaryManifestRenderOptions {
	maxReferences?: number;
	maxRangesPerReference?: number;
	maxModifiedFiles?: number;
	maxPendingProcesses?: number;
	maxCharacters?: number;
}

interface SessionSummaryProgressiveContentEnvelope {
	schemaVersion: typeof SESSION_SUMMARY_PROGRESSIVE_CONTENT_SCHEMA_VERSION;
	contentManifest: CompactionContentManifest;
	rollover?: SessionSummaryManifestRollover;
}

interface SessionSummaryManifestRollover {
	omittedReferences: number;
	omittedRanges: number;
	omittedModifiedFiles: number;
	omittedPendingProcesses: number;
}

interface ManifestMergeResult {
	manifest: CompactionContentManifest;
	rollover: SessionSummaryManifestRollover;
}

const EMPTY_ROLLOVER: SessionSummaryManifestRollover = {
	omittedReferences: 0,
	omittedRanges: 0,
	omittedModifiedFiles: 0,
	omittedPendingProcesses: 0,
};

function metadataRecord(
	metadata: Record<string, JsonValue> | undefined,
): Record<string, unknown> | undefined {
	return metadata as Record<string, unknown> | undefined;
}

function objectRecord(value: unknown, label: string): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${label} must be an object`);
	}
	return value as Record<string, unknown>;
}

function validateProgressiveContentEnvelope(
	value: unknown,
): SessionSummaryProgressiveContentEnvelope {
	const envelope = objectRecord(value, "progressive content metadata envelope");
	const unsupported = Object.keys(envelope).filter(
		(key) => !ENVELOPE_KEYS.has(key),
	);
	if (unsupported.length > 0) {
		throw new TypeError(
			`progressive content metadata envelope contains unsupported field(s): ${unsupported.join(", ")}`,
		);
	}
	if (
		envelope.schemaVersion !==
		SESSION_SUMMARY_PROGRESSIVE_CONTENT_SCHEMA_VERSION
	) {
		throw new TypeError(
			"progressive content metadata envelope schemaVersion is unsupported",
		);
	}
	const rollover =
		envelope.rollover === undefined
			? undefined
			: validateRollover(envelope.rollover);
	return {
		schemaVersion: SESSION_SUMMARY_PROGRESSIVE_CONTENT_SCHEMA_VERSION,
		contentManifest: restartResolvableManifest(envelope.contentManifest),
		...(rollover ? { rollover } : {}),
	};
}

function progressiveContentEnvelope(
	contentManifest: CompactionContentManifest,
	rollover: SessionSummaryManifestRollover,
): SessionSummaryProgressiveContentEnvelope {
	return {
		schemaVersion: SESSION_SUMMARY_PROGRESSIVE_CONTENT_SCHEMA_VERSION,
		contentManifest,
		...(hasRollover(rollover) ? { rollover } : {}),
	};
}

function nonnegativeInteger(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${label} must be a nonnegative safe integer`);
	}
	return value;
}

function validateRollover(value: unknown): SessionSummaryManifestRollover {
	const rollover = objectRecord(value, "progressive content rollover");
	const unsupported = Object.keys(rollover).filter(
		(key) => !ROLLOVER_KEYS.has(key),
	);
	if (unsupported.length > 0) {
		throw new TypeError(
			`progressive content rollover contains unsupported field(s): ${unsupported.join(", ")}`,
		);
	}
	return {
		omittedReferences: nonnegativeInteger(
			rollover.omittedReferences,
			"progressive content rollover omittedReferences",
		),
		omittedRanges: nonnegativeInteger(
			rollover.omittedRanges,
			"progressive content rollover omittedRanges",
		),
		omittedModifiedFiles: nonnegativeInteger(
			rollover.omittedModifiedFiles,
			"progressive content rollover omittedModifiedFiles",
		),
		omittedPendingProcesses: nonnegativeInteger(
			rollover.omittedPendingProcesses,
			"progressive content rollover omittedPendingProcesses",
		),
	};
}

function hasRollover(rollover: SessionSummaryManifestRollover): boolean {
	return Object.values(rollover).some((count) => count > 0);
}

function maxRollover(
	left: SessionSummaryManifestRollover,
	right: SessionSummaryManifestRollover,
): SessionSummaryManifestRollover {
	return {
		omittedReferences: Math.max(
			left.omittedReferences,
			right.omittedReferences,
		),
		omittedRanges: Math.max(left.omittedRanges, right.omittedRanges),
		omittedModifiedFiles: Math.max(
			left.omittedModifiedFiles,
			right.omittedModifiedFiles,
		),
		omittedPendingProcesses: Math.max(
			left.omittedPendingProcesses,
			right.omittedPendingProcesses,
		),
	};
}

function referenceKey(entry: CompactionContentEntry): string {
	return `${entry.reference.kind}\u0000${entry.reference.ref}`;
}

function rangeKey(range: CompactionContentRange): string {
	return `${range.unit}:${range.start}:${range.end}`;
}

function laterTimestamp(left: string, right: string): string {
	return Date.parse(right) > Date.parse(left) ? right : left;
}

function compareTimestampDescending(left: string, right: string): number {
	return Date.parse(right) - Date.parse(left);
}

function compareEntryByRecency(
	left: CompactionContentEntry,
	right: CompactionContentEntry,
): number {
	return (
		compareTimestampDescending(left.lastUsedAt, right.lastUsedAt) ||
		referenceKey(left).localeCompare(referenceKey(right))
	);
}

function mergeSameRevisionEntry(
	existing: CompactionContentEntry,
	incoming: CompactionContentEntry,
): { entry: CompactionContentEntry; omittedRanges: number } {
	const ranges = new Map<
		string,
		{ range: CompactionContentRange; lastUsedAt: string }
	>();
	for (const range of existing.rangesUsed) {
		ranges.set(rangeKey(range), { range, lastUsedAt: existing.lastUsedAt });
	}
	for (const range of incoming.rangesUsed) {
		const key = rangeKey(range);
		const prior = ranges.get(key);
		if (
			!prior ||
			Date.parse(incoming.lastUsedAt) >= Date.parse(prior.lastUsedAt)
		) {
			ranges.set(key, { range, lastUsedAt: incoming.lastUsedAt });
		}
	}
	const candidates = [...ranges.entries()].sort(
		([leftKey, left], [rightKey, right]) =>
			compareTimestampDescending(left.lastUsedAt, right.lastUsedAt) ||
			leftKey.localeCompare(rightKey),
	);
	const selected = candidates.slice(
		0,
		COMPACTION_CONTENT_MANIFEST_MAX_RANGES_PER_REFERENCE,
	);
	const selectedRanges = selected
		.map(([, candidate]) => candidate.range)
		.sort((left, right) => rangeKey(left).localeCompare(rangeKey(right)));
	const existingRevision = existing.revision ?? existing.reference.revision;
	return {
		entry: {
			...existing,
			...incoming,
			reference: existing.reference,
			...(existingRevision ? { revision: existingRevision } : {}),
			rangesUsed: selectedRanges,
			lastUsedAt: laterTimestamp(existing.lastUsedAt, incoming.lastUsedAt),
			retained: existing.retained || incoming.retained,
		},
		omittedRanges: candidates.length - selected.length,
	};
}

function mergeTwoManifests(
	left: CompactionContentManifest,
	right: CompactionContentManifest,
): ManifestMergeResult {
	const contentRefs = new Map<string, CompactionContentEntry>();
	let omittedRanges = 0;
	for (const incoming of [...left.contentRefs, ...right.contentRefs]) {
		const key = referenceKey(incoming);
		const existing = contentRefs.get(key);
		if (!existing) {
			contentRefs.set(key, incoming);
			continue;
		}
		const existingRevision = existing.revision ?? existing.reference.revision;
		const incomingRevision = incoming.revision ?? incoming.reference.revision;
		if (existingRevision !== incomingRevision) {
			// Ranges are revision-bound. The later manifest deliberately supersedes
			// the prior revision rather than mixing offsets or bricking the rolling
			// summary on the canonical validator's revision-conflict invariant.
			contentRefs.set(key, incoming);
			continue;
		}
		const mergedEntry = mergeSameRevisionEntry(existing, incoming);
		contentRefs.set(key, mergedEntry.entry);
		omittedRanges += mergedEntry.omittedRanges;
	}
	const referenceCandidates = [...contentRefs.values()].sort(
		compareEntryByRecency,
	);
	let retainedReferences = referenceCandidates.slice(
		0,
		COMPACTION_CONTENT_MANIFEST_MAX_REFERENCES,
	);
	let omittedReferences =
		referenceCandidates.length - retainedReferences.length;

	const modifiedFiles = new Map<
		string,
		CompactionContentManifest["modifiedFiles"][number]
	>();
	const modifiedPriority = new Map<string, number>();
	for (const [priority, source] of [
		left.modifiedFiles,
		right.modifiedFiles,
	].entries()) {
		for (const incoming of source) {
			const key = `${incoming.reference.kind}\u0000${incoming.reference.ref}`;
			const existing = modifiedFiles.get(key);
			const existingRevision =
				existing?.revision ?? existing?.reference.revision;
			const incomingRevision = incoming.revision ?? incoming.reference.revision;
			modifiedFiles.set(
				key,
				existing && existingRevision === incomingRevision ? existing : incoming,
			);
			modifiedPriority.set(key, priority);
		}
	}
	const modifiedCandidates = [...modifiedFiles.entries()].sort(
		([leftKey], [rightKey]) =>
			(modifiedPriority.get(rightKey) ?? 0) -
				(modifiedPriority.get(leftKey) ?? 0) || leftKey.localeCompare(rightKey),
	);
	let retainedModifiedCandidates = modifiedCandidates.slice(
		0,
		COMPACTION_CONTENT_MANIFEST_MAX_REFERENCES,
	);
	let omittedModifiedFiles =
		modifiedCandidates.length - retainedModifiedCandidates.length;

	const pendingProcesses = new Map<
		string,
		CompactionContentManifest["pendingProcesses"][number]
	>();
	const pendingPriority = new Map<string, number>();
	for (const [priority, source] of [
		left.pendingProcesses,
		right.pendingProcesses,
	].entries()) {
		for (const process of source) {
			pendingProcesses.set(process.id, {
				...pendingProcesses.get(process.id),
				...process,
			});
			pendingPriority.set(process.id, priority);
		}
	}
	const pendingCandidates = [...pendingProcesses.entries()].sort(
		([leftId], [rightId]) =>
			(pendingPriority.get(rightId) ?? 0) -
				(pendingPriority.get(leftId) ?? 0) || leftId.localeCompare(rightId),
	);
	let retainedPendingCandidates = pendingCandidates.slice(
		0,
		COMPACTION_CONTENT_MANIFEST_MAX_PENDING_PROCESSES,
	);
	let omittedPendingProcesses =
		pendingCandidates.length - retainedPendingCandidates.length;

	const serializedBytes = (): number =>
		new TextEncoder().encode(
			JSON.stringify({
				schemaVersion: left.schemaVersion,
				contentRefs: retainedReferences,
				modifiedFiles: retainedModifiedCandidates.map(([, file]) => file),
				pendingProcesses: retainedPendingCandidates.map(
					([, process]) => process,
				),
			}),
		).byteLength;
	while (serializedBytes() > COMPACTION_CONTENT_MANIFEST_MAX_BYTES) {
		// Byte pressure is exceptional after count pruning. Preserve the central
		// recoverable-reference ledger longest: evict lowest-priority pending work,
		// then modified-file markers, then the least-recent content reference.
		if (retainedPendingCandidates.length > 0) {
			retainedPendingCandidates = retainedPendingCandidates.slice(0, -1);
			omittedPendingProcesses += 1;
			continue;
		}
		if (retainedModifiedCandidates.length > 0) {
			retainedModifiedCandidates = retainedModifiedCandidates.slice(0, -1);
			omittedModifiedFiles += 1;
			continue;
		}
		if (retainedReferences.length > 0) {
			retainedReferences = retainedReferences.slice(0, -1);
			omittedReferences += 1;
			continue;
		}
		throw new TypeError(
			"content manifest fixed fields exceed serialized bound",
		);
	}
	const retainedModifiedFiles = retainedModifiedCandidates
		.sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
		.map(([, file]) => file);
	const retainedPendingProcesses = retainedPendingCandidates
		.sort(([leftId], [rightId]) => leftId.localeCompare(rightId))
		.map(([, process]) => process);

	return {
		manifest: validateCompactionContentManifest({
			schemaVersion: left.schemaVersion,
			contentRefs: retainedReferences,
			modifiedFiles: retainedModifiedFiles,
			pendingProcesses: retainedPendingProcesses,
		}),
		rollover: {
			omittedReferences,
			omittedRanges,
			omittedModifiedFiles,
			omittedPendingProcesses,
		},
	};
}

/** Read and strictly validate a manifest stored in session-summary metadata. */
export function parseSessionSummaryContentManifest(
	metadata: Record<string, JsonValue> | undefined,
): CompactionContentManifest | undefined {
	const value =
		metadataRecord(metadata)?.[
			SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY
		];
	return value === undefined
		? undefined
		: validateProgressiveContentEnvelope(value).contentManifest;
}

/**
 * Merge manifests without silently dropping references. Every input and the
 * final union pass the canonical persisted-manifest validator and its bounds.
 */
export function mergeSessionSummaryContentManifests(
	manifests: readonly unknown[],
): CompactionContentManifest | undefined {
	return mergeSessionSummaryContentManifestsWithRollover(manifests).manifest;
}

function mergeSessionSummaryContentManifestsWithRollover(
	manifests: readonly unknown[],
	initialRollover: SessionSummaryManifestRollover = EMPTY_ROLLOVER,
): {
	manifest: CompactionContentManifest | undefined;
	rollover: SessionSummaryManifestRollover;
} {
	let merged: CompactionContentManifest | undefined;
	let rollover = initialRollover;
	for (const value of manifests) {
		if (value === undefined) continue;
		const manifest = validateCompactionContentManifest(value);
		if (!merged) {
			merged = manifest;
			continue;
		}
		const result = mergeTwoManifests(merged, manifest);
		merged = result.manifest;
		rollover = maxRollover(rollover, result.rollover);
	}
	return { manifest: merged, rollover };
}

/**
 * Build the next metadata value for the rolling-summary write. Existing keys
 * survive, key points are refreshed, and content manifests can only be added or
 * merged—not erased by an ordinary summary update.
 */
export function mergeSessionSummaryMetadata(
	existingMetadata: Record<string, JsonValue> | undefined,
	keyPoints: readonly string[],
	incomingManifests: readonly unknown[] = [],
): Record<string, JsonValue> {
	const existingEnvelopeValue =
		metadataRecord(existingMetadata)?.[
			SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY
		];
	const existingEnvelope =
		existingEnvelopeValue === undefined
			? undefined
			: validateProgressiveContentEnvelope(existingEnvelopeValue);
	const { manifest: contentManifest, rollover } =
		mergeSessionSummaryContentManifestsWithRollover(
			[existingEnvelope?.contentManifest, ...incomingManifests],
			existingEnvelope?.rollover ?? EMPTY_ROLLOVER,
		);
	return {
		...existingMetadata,
		keyPoints: [...keyPoints],
		...(contentManifest
			? {
					[SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY]:
						progressiveContentEnvelope(
							contentManifest,
							rollover,
						) as unknown as JsonValue,
				}
			: {}),
	};
}

/** Return manifest candidates explicitly attached to the summarized messages. */
export function messageContentManifestCandidates(
	messages: readonly Memory[],
): unknown[] {
	return messages.flatMap((message) => {
		const value = (message.metadata as Record<string, unknown> | undefined)?.[
			SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY
		];
		if (value === undefined) return [];
		const candidate = restartResolvableManifest(
			validateProgressiveContentEnvelope(value).contentManifest,
		);
		return candidate.contentRefs.length === 0 ? [] : [candidate];
	});
}

function positiveInteger(
	value: number | undefined,
	fallback: number,
	label: string,
): number {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new TypeError(`${label} must be a positive safe integer`);
	}
	return value;
}

function formatReference(
	reference: CompactionContentEntry["reference"],
	revision?: string,
): string {
	const prefix = `${reference.kind}:`;
	if (reference.ref.startsWith(prefix)) {
		const expectedRevision = revision ? ` expectedRevision=${revision}` : "";
		if (reference.kind === "document") {
			return `DOCUMENT action=read documentId=${reference.ref.slice(prefix.length)}${expectedRevision}`;
		}
		if (reference.kind === "memory") {
			return `MESSAGE action=read_channel reference=${reference.ref}${expectedRevision}`;
		}
		if (reference.kind === "attachment") {
			return `ATTACHMENT reference=${reference.ref}${expectedRevision}`;
		}
	}
	const canonicalRef = reference.ref.startsWith(`${reference.kind}:`)
		? reference.ref
		: `${reference.kind}:${reference.ref}`;
	return `${canonicalRef}${revision ? `@${revision}` : ""}`;
}

/** Render only opaque handles and offsets; entry reasons and bodies are omitted. */
export function renderSessionSummaryContentManifest(
	metadata: Record<string, JsonValue> | undefined,
	options: SessionSummaryManifestRenderOptions = {},
): string {
	const envelopeValue =
		metadataRecord(metadata)?.[
			SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY
		];
	if (envelopeValue === undefined) return "";
	const envelope = validateProgressiveContentEnvelope(envelopeValue);
	const manifest = envelope.contentManifest;
	const maxReferences = positiveInteger(
		options.maxReferences,
		DEFAULT_MAX_RENDERED_REFERENCES,
		"maxReferences",
	);
	const maxRanges = positiveInteger(
		options.maxRangesPerReference,
		DEFAULT_MAX_RENDERED_RANGES,
		"maxRangesPerReference",
	);
	const maxModifiedFiles = positiveInteger(
		options.maxModifiedFiles,
		DEFAULT_MAX_RENDERED_MODIFIED_FILES,
		"maxModifiedFiles",
	);
	const maxPendingProcesses = positiveInteger(
		options.maxPendingProcesses,
		DEFAULT_MAX_RENDERED_PENDING_PROCESSES,
		"maxPendingProcesses",
	);
	const maxCharacters = positiveInteger(
		options.maxCharacters,
		DEFAULT_MAX_RENDERED_CHARACTERS,
		"maxCharacters",
	);
	if (
		manifest.contentRefs.length === 0 &&
		manifest.modifiedFiles.length === 0 &&
		manifest.pendingProcesses.length === 0 &&
		!(envelope.rollover && hasRollover(envelope.rollover))
	) {
		return "";
	}
	const lines = ["**Recoverable content references (source bodies omitted)**"];
	for (const entry of manifest.contentRefs.slice(0, maxReferences)) {
		const ranges = entry.rangesUsed
			.slice(0, maxRanges)
			.map((range) => `${range.unit}:${range.start}-${range.end}`)
			.join(", ");
		lines.push(
			`- ${formatReference(entry.reference, entry.revision)}${ranges ? ` [${ranges}]` : ""}`,
		);
	}
	if (manifest.contentRefs.length > maxReferences) {
		lines.push(
			`- … ${manifest.contentRefs.length - maxReferences} more references`,
		);
	}
	for (const file of manifest.modifiedFiles.slice(0, maxModifiedFiles)) {
		lines.push(`- modified ${formatReference(file.reference, file.revision)}`);
	}
	if (manifest.modifiedFiles.length > maxModifiedFiles) {
		lines.push(
			`- … ${manifest.modifiedFiles.length - maxModifiedFiles} more modified files`,
		);
	}
	for (const process of manifest.pendingProcesses.slice(
		0,
		maxPendingProcesses,
	)) {
		const output = process.outputReference
			? ` -> ${formatReference(process.outputReference, process.outputReference.revision)}`
			: "";
		const offset = process.offset === undefined ? "" : ` @${process.offset}`;
		lines.push(`- pending ${process.id}${output}${offset}`);
	}
	if (manifest.pendingProcesses.length > maxPendingProcesses) {
		lines.push(
			`- … ${manifest.pendingProcesses.length - maxPendingProcesses} more pending processes`,
		);
	}
	if (envelope.rollover && hasRollover(envelope.rollover)) {
		const rollover = envelope.rollover;
		lines.push(
			`- bounded-ledger rollover high-water: references=${rollover.omittedReferences}, ranges=${rollover.omittedRanges}, modified=${rollover.omittedModifiedFiles}, pending=${rollover.omittedPendingProcesses}`,
		);
	}

	let rendered = "";
	for (const line of lines) {
		const candidate = rendered ? `${rendered}\n${line}` : line;
		if (candidate.length > maxCharacters) {
			const suffix = "\n- … additional manifest entries omitted";
			return `${rendered.slice(0, Math.max(0, maxCharacters - suffix.length))}${suffix}`.slice(
				0,
				maxCharacters,
			);
		}
		rendered = candidate;
	}
	return rendered;
}
