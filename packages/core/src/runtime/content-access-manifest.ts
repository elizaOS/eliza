/**
 * Derives the content-reference ledger that an archive or future compaction
 * seam must retain independently of an LLM-authored summary. The walker reads
 * only model-safe prompt projections, applies strict traversal bounds, and
 * never copies source text into the manifest.
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
	maxVisitedValues?: number;
	maxDepth?: number;
}

const DEFAULT_MAX_REFERENCES = COMPACTION_CONTENT_MANIFEST_MAX_REFERENCES;
const DEFAULT_MAX_RANGES_PER_REFERENCE =
	COMPACTION_CONTENT_MANIFEST_MAX_RANGES_PER_REFERENCE;
const DEFAULT_MAX_VISITED_VALUES = 10_000;
const DEFAULT_MAX_DEPTH = 8;

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
	return `${reference.kind}\u0000${reference.ref}\u0000${reference.revision ?? ""}`;
}

function rangeKey(range: CompactionContentRange): string {
	return `${range.unit}:${range.start}:${range.end}`;
}

/**
 * Build a content-free manifest from the prompt-safe projections in a planner
 * trajectory. Active and archived steps are treated identically so moving a
 * settled step across an archive boundary cannot erase its continuation state.
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
	const maxVisitedValues = positiveSafeInteger(
		options.maxVisitedValues,
		DEFAULT_MAX_VISITED_VALUES,
		"maxVisitedValues",
	);
	const maxDepth = positiveSafeInteger(
		options.maxDepth,
		DEFAULT_MAX_DEPTH,
		"maxDepth",
	);
	const lastUsedAt = canonicalTimestamp(options.lastUsedAt, "lastUsedAt");
	const entries = new Map<
		string,
		CompactionContentEntry & { rangeKeys: Set<string> }
	>();
	let visitedValues = 0;

	const addReference = (
		reference: ContentReference,
		reason: string,
		range?: CompactionContentRange,
	) => {
		const key = referenceKey(reference);
		let entry = entries.get(key);
		if (!entry) {
			if (entries.size >= maxReferences) {
				throw new ElizaError(
					"Content manifest exceeds the configured reference bound",
					{
						code: "CONTENT_MANIFEST_BOUND_EXCEEDED",
						context: { bound: "references", maxReferences },
					},
				);
			}
			entry = {
				reference,
				...(reference.revision ? { revision: reference.revision } : {}),
				reason,
				rangesUsed: [],
				lastUsedAt,
				retained: true,
				rangeKeys: new Set(),
			};
			entries.set(key, entry);
		}
		if (!range) return;
		const keyForRange = rangeKey(range);
		if (entry.rangeKeys.has(keyForRange)) return;
		if (entry.rangesUsed.length >= maxRangesPerReference) {
			throw new ElizaError(
				"Content manifest exceeds the configured per-reference range bound",
				{
					code: "CONTENT_MANIFEST_BOUND_EXCEEDED",
					context: {
						bound: "ranges",
						maxRangesPerReference,
					},
				},
			);
		}
		entry.rangeKeys.add(keyForRange);
		entry.rangesUsed.push(range);
	};

	const visit = (root: unknown, reason: string) => {
		const pending: Array<{ value: unknown; depth: number }> = [
			{ value: root, depth: 0 },
		];
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current) break;
			visitedValues++;
			if (visitedValues > maxVisitedValues) {
				throw new ElizaError(
					"Content manifest traversal exceeds the configured value bound",
					{
						code: "CONTENT_MANIFEST_BOUND_EXCEEDED",
						context: { bound: "values", maxVisitedValues },
					},
				);
			}
			if (isReadView(current.value)) {
				addReference(current.value.reference, reason, {
					unit: current.value.slice.range.unit,
					start: current.value.slice.range.start,
					end: current.value.slice.range.end,
				});
				continue;
			}
			if (isContentReference(current.value)) {
				addReference(current.value, reason);
				continue;
			}
			if (
				current.depth >= maxDepth ||
				current.value === null ||
				typeof current.value !== "object"
			) {
				continue;
			}
			for (const child of Array.isArray(current.value)
				? current.value
				: Object.values(current.value as Record<string, unknown>)) {
				pending.push({ value: child, depth: current.depth + 1 });
			}
		}
	};

	for (const step of [...trajectory.archivedSteps, ...trajectory.steps]) {
		if (!step.result?.promptData) continue;
		visit(step.result.promptData, `tool:${step.toolCall?.name ?? "unknown"}`);
	}

	return validateCompactionContentManifest({
		schemaVersion: COMPACTION_CONTENT_MANIFEST_SCHEMA_VERSION,
		contentRefs: [...entries.values()].map(
			({ rangeKeys: _rangeKeys, ...entry }) => ({
				...entry,
				rangesUsed: [...entry.rangesUsed].sort(
					(a, b) =>
						a.unit.localeCompare(b.unit) || a.start - b.start || a.end - b.end,
				),
			}),
		),
		modifiedFiles: [],
		pendingProcesses: [],
	});
}
