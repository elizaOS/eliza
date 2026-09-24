/**
 * Derives the content-reference ledger that an archive or future compaction
 * seam must retain independently of an LLM-authored summary. The walker reads
 * every tool-result carrier with cycle-safe traversal and never copies source
 * text into the manifest.
 */

import { ElizaError } from "../errors";
import {
	type ContentReference,
	isContentReference,
	isReadView,
} from "../types/content";
import {
	COMPACTION_CONTENT_MANIFEST_MAX_RANGES_PER_REFERENCE,
	COMPACTION_CONTENT_MANIFEST_MAX_REFERENCES,
	COMPACTION_CONTENT_MANIFEST_SCHEMA_VERSION,
	type CompactionContentEntry,
	type CompactionContentManifest,
	type CompactionContentRange,
	validateCompactionContentManifest,
} from "../types/content-manifest";
import type { PlannerTrajectory } from "./planner-types";

export interface DeriveCompactionContentManifestOptions {
	lastUsedAt: string;
	maxReferences?: number;
	maxRangesPerReference?: number;
	/** @deprecated Traversal is complete and no longer value-bounded. */
	maxVisitedValues?: number;
	/** @deprecated Traversal is complete and no longer depth-bounded. */
	maxDepth?: number;
}

export interface DeriveCompactionContentManifestsOptions {
	lastUsedAt: string;
}

const DEFAULT_MAX_REFERENCES = COMPACTION_CONTENT_MANIFEST_MAX_REFERENCES;
const DEFAULT_MAX_RANGES_PER_REFERENCE =
	COMPACTION_CONTENT_MANIFEST_MAX_RANGES_PER_REFERENCE;

function positiveSafeInteger(
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

function canonicalTimestamp(value: string, label: string): string {
	const epoch = Date.parse(value);
	if (!Number.isFinite(epoch) || new Date(epoch).toISOString() !== value) {
		throw new TypeError(`${label} must be an ISO-8601 UTC timestamp`);
	}
	return value;
}

function referenceKey(reference: ContentReference): string {
	return `${reference.kind}\u0000${reference.ref}`;
}

function rangeKey(range: CompactionContentRange): string {
	return `${range.unit}:${range.start}:${range.end}`;
}

function collectRestartSafeContentEntries(
	trajectory: Pick<PlannerTrajectory, "steps" | "archivedSteps">,
	lastUsedAt: string,
): CompactionContentEntry[] {
	const entries = new Map<
		string,
		CompactionContentEntry & { rangeKeys: Set<string> }
	>();

	const addReference = (
		reference: ContentReference,
		reason: string,
		range?: CompactionContentRange,
	) => {
		if (reference.resumability !== "restart-safe") return;
		const key = referenceKey(reference);
		let entry = entries.get(key);
		if (!entry) {
			entry = {
				reference,
				...(reference.revision ? { revision: reference.revision } : {}),
				reason,
				rangesUsed: [],
				lastUsedAt,
				retained: true,
				...(reference.expiresAt ? { expiresAt: reference.expiresAt } : {}),
				rangeKeys: new Set(),
			};
			entries.set(key, entry);
		} else {
			const existingRevision = entry.revision ?? entry.reference.revision;
			const incomingRevision = reference.revision;
			if (
				existingRevision !== undefined &&
				incomingRevision !== undefined &&
				existingRevision !== incomingRevision
			) {
				throw new ElizaError(
					"Content manifest encountered conflicting source revisions",
					{
						code: "CONTENT_MANIFEST_REVISION_CONFLICT",
						context: { kind: reference.kind },
					},
				);
			}
			if (existingRevision === undefined && incomingRevision !== undefined) {
				entry.reference = reference;
				entry.revision = incomingRevision;
			}
		}
		if (!range) return;
		const keyForRange = rangeKey(range);
		if (entry.rangeKeys.has(keyForRange)) return;
		entry.rangeKeys.add(keyForRange);
		entry.rangesUsed.push(range);
	};

	const visit = (root: unknown, reason: string) => {
		const pending: unknown[] = [root];
		const visited = new WeakSet<object>();
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current) continue;
			if (isReadView(current)) {
				addReference(current.reference, reason, {
					unit: current.slice.range.unit,
					start: current.slice.range.start,
					end: current.slice.range.end,
				});
				continue;
			}
			if (isContentReference(current)) {
				addReference(current, reason);
				continue;
			}
			if (current === null || typeof current !== "object") {
				continue;
			}
			if (visited.has(current)) continue;
			visited.add(current);
			for (const child of Array.isArray(current)
				? current
				: Object.values(current as Record<string, unknown>)) {
				pending.push(child);
			}
		}
	};

	for (const step of [...trajectory.archivedSteps, ...trajectory.steps]) {
		if (!step.result) continue;
		const reason = `tool:${step.toolCall?.name ?? "unknown"}`;
		if (step.result.data !== undefined) visit(step.result.data, reason);
		if (step.result.promptData !== undefined)
			visit(step.result.promptData, reason);
	}
	return [...entries.values()].map(({ rangeKeys: _rangeKeys, ...entry }) => ({
		...entry,
		rangesUsed: [...entry.rangesUsed].sort(
			(a, b) =>
				a.unit.localeCompare(b.unit) || a.start - b.start || a.end - b.end,
		),
	}));
}

function manifestFor(contentRefs: CompactionContentEntry[]) {
	return {
		schemaVersion: COMPACTION_CONTENT_MANIFEST_SCHEMA_VERSION,
		contentRefs,
		modifiedFiles: [],
		pendingProcesses: [],
	};
}

/**
 * Build one content-free manifest for compatibility callers with explicit
 * bounds. Durable publication uses deriveCompactionContentManifests so count
 * pressure creates additional immutable shards instead of losing continuity.
 */
export function deriveCompactionContentManifest(
	trajectory: Pick<PlannerTrajectory, "steps" | "archivedSteps">,
	options: DeriveCompactionContentManifestOptions,
): CompactionContentManifest {
	const maxReferences = positiveSafeInteger(
		options.maxReferences,
		DEFAULT_MAX_REFERENCES,
		"maxReferences",
	);
	const maxRangesPerReference = positiveSafeInteger(
		options.maxRangesPerReference,
		DEFAULT_MAX_RANGES_PER_REFERENCE,
		"maxRangesPerReference",
	);
	const entries = collectRestartSafeContentEntries(
		trajectory,
		canonicalTimestamp(options.lastUsedAt, "lastUsedAt"),
	);
	if (entries.length > maxReferences) {
		throw new ElizaError(
			"Content manifest exceeds the configured reference bound",
			{
				code: "CONTENT_MANIFEST_BOUND_EXCEEDED",
				context: { bound: "references", maxReferences },
			},
		);
	}
	if (
		entries.some((entry) => entry.rangesUsed.length > maxRangesPerReference)
	) {
		throw new ElizaError(
			"Content manifest exceeds the configured per-reference range bound",
			{
				code: "CONTENT_MANIFEST_BOUND_EXCEEDED",
				context: { bound: "ranges", maxRangesPerReference },
			},
		);
	}
	return validateCompactionContentManifest(manifestFor(entries));
}

/** Derive every restart-safe record and split only at lossless schema bounds. */
export function deriveCompactionContentManifests(
	trajectory: Pick<PlannerTrajectory, "steps" | "archivedSteps">,
	options: DeriveCompactionContentManifestsOptions,
): CompactionContentManifest[] {
	const entries = collectRestartSafeContentEntries(
		trajectory,
		canonicalTimestamp(options.lastUsedAt, "lastUsedAt"),
	).flatMap((entry) => {
		if (entry.rangesUsed.length === 0) return [entry];
		const chunks: CompactionContentEntry[] = [];
		for (
			let offset = 0;
			offset < entry.rangesUsed.length;
			offset += COMPACTION_CONTENT_MANIFEST_MAX_RANGES_PER_REFERENCE
		) {
			chunks.push({
				...entry,
				rangesUsed: entry.rangesUsed.slice(
					offset,
					offset + COMPACTION_CONTENT_MANIFEST_MAX_RANGES_PER_REFERENCE,
				),
			});
		}
		return chunks;
	});
	const manifests: CompactionContentManifest[] = [];
	let current: CompactionContentEntry[] = [];
	for (const entry of entries) {
		const candidate = [...current, entry];
		try {
			validateCompactionContentManifest(manifestFor(candidate));
			current = candidate;
		} catch (error) {
			if (current.length === 0) throw error;
			manifests.push(validateCompactionContentManifest(manifestFor(current)));
			current = [entry];
			validateCompactionContentManifest(manifestFor(current));
		}
	}
	if (current.length > 0) {
		manifests.push(validateCompactionContentManifest(manifestFor(current)));
	}
	return manifests;
}
