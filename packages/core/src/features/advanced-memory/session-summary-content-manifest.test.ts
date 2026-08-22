/**
 * Verifies strict session-summary manifest parsing, lossless rolling merges,
 * and bounded prompt rendering using deterministic in-memory fixtures.
 */

import { describe, expect, it } from "vitest";
import type { CompactionContentManifest } from "../../types/content-manifest.ts";
import type { JsonValue } from "../../types/primitives.ts";
import {
	mergeSessionSummaryMetadata,
	parseSessionSummaryContentManifest,
	renderSessionSummaryContentManifest,
	SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY,
} from "./session-summary-content-manifest.ts";

function manifest(
	ref: string,
	options: {
		reason?: string;
		start?: number;
		end?: number;
		lastUsedAt?: string;
	} = {},
): CompactionContentManifest {
	return {
		schemaVersion: 1,
		contentRefs: [
			{
				reference: { kind: "document", ref, revision: "rev-1" },
				revision: "rev-1",
				reason: options.reason ?? "tool:read_document",
				rangesUsed: [
					{
						unit: "fragment",
						start: options.start ?? 0,
						end: options.end ?? 2,
					},
				],
				lastUsedAt: options.lastUsedAt ?? "2026-08-21T20:00:00.000Z",
				retained: true,
			},
		],
		modifiedFiles: [],
		pendingProcesses: [],
	};
}

function metadataWithManifest(
	value: CompactionContentManifest,
): Record<string, JsonValue> {
	return {
		[SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY]: {
			schemaVersion: 1,
			contentManifest: value,
		} as unknown as JsonValue,
	};
}

function manifestEntry(ref: string) {
	const [entry] = manifest(ref).contentRefs;
	if (!entry) throw new Error("fixture manifest must contain one reference");
	return entry;
}

function progressiveEnvelope(metadata: Record<string, JsonValue>) {
	const value = metadata[SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY];
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("fixture metadata must contain a progressive envelope");
	}
	return value as Record<string, JsonValue>;
}

function rolloverCounters(metadata: Record<string, JsonValue>) {
	const rollover = progressiveEnvelope(metadata).rollover;
	if (
		rollover === null ||
		typeof rollover !== "object" ||
		Array.isArray(rollover)
	) {
		throw new Error("fixture metadata must contain rollover counters");
	}
	return rollover as Record<string, JsonValue>;
}

describe("session-summary content manifest persistence", () => {
	it("rejects an invalid namespaced manifest instead of treating it as absent", () => {
		expect(() =>
			parseSessionSummaryContentManifest({
				[SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY]: {
					schemaVersion: 1,
					contentManifest: {
						schemaVersion: 1,
						contentRefs: [{ body: "unvalidated source text" }],
						modifiedFiles: [],
						pendingProcesses: [],
					},
				},
			}),
		).toThrow();
	});

	it("ignores and preserves an arbitrary legacy contentManifest key", () => {
		const legacy = {
			contentManifest: {
				custom: "application-owned value",
				body: "not an elizaOS progressive-content envelope",
			},
		} satisfies Record<string, JsonValue>;

		expect(parseSessionSummaryContentManifest(legacy)).toBeUndefined();
		expect(
			mergeSessionSummaryMetadata(legacy, ["point"]).contentManifest,
		).toEqual(legacy.contentManifest);
	});

	it("rejects an unsupported namespaced envelope version", () => {
		expect(() =>
			parseSessionSummaryContentManifest({
				[SESSION_SUMMARY_PROGRESSIVE_CONTENT_METADATA_KEY]: {
					schemaVersion: 2,
					contentManifest: manifest("future-envelope"),
				},
			}),
		).toThrow(/schemaVersion is unsupported/);
	});

	it("preserves unrelated metadata and unions ranges for the same reference", () => {
		const existing = {
			owner: "advanced-memory",
			...metadataWithManifest(manifest("doc-1")),
		} satisfies Record<string, JsonValue>;
		const incoming = manifest("doc-1", {
			start: 4,
			end: 8,
			lastUsedAt: "2026-08-21T21:00:00.000Z",
		});

		const mergedMetadata = mergeSessionSummaryMetadata(
			existing,
			["decision"],
			[incoming],
		);
		const merged = parseSessionSummaryContentManifest(mergedMetadata);

		expect(mergedMetadata.owner).toBe("advanced-memory");
		expect(mergedMetadata.keyPoints).toEqual(["decision"]);
		expect(merged?.contentRefs).toHaveLength(1);
		expect(merged?.contentRefs[0]?.rangesUsed).toEqual([
			{ unit: "fragment", start: 0, end: 2 },
			{ unit: "fragment", start: 4, end: 8 },
		]);
		expect(merged?.contentRefs[0]?.lastUsedAt).toBe("2026-08-21T21:00:00.000Z");
	});

	it("cannot erase an existing manifest when a summary update has no new one", () => {
		const existing = metadataWithManifest(manifest("doc-still-here"));
		const updated = mergeSessionSummaryMetadata(existing, ["new key point"]);

		expect(parseSessionSummaryContentManifest(updated)).toEqual(
			manifest("doc-still-here"),
		);
	});

	it("supersedes revision-bound ranges when a source revision changes", () => {
		const existing = metadataWithManifest(manifest("doc-changing"));
		const revised = manifest("doc-changing", { start: 10, end: 12 });
		const revisedEntry = revised.contentRefs[0];
		if (!revisedEntry)
			throw new Error("fixture manifest must contain a reference");
		revisedEntry.reference.revision = "rev-2";
		revisedEntry.revision = "rev-2";

		const updated = mergeSessionSummaryMetadata(existing, [], [revised]);
		const persisted = parseSessionSummaryContentManifest(updated);

		expect(persisted?.contentRefs).toHaveLength(1);
		expect(persisted?.contentRefs[0]?.revision).toBe("rev-2");
		expect(persisted?.contentRefs[0]?.rangesUsed).toEqual([
			{ unit: "fragment", start: 10, end: 12 },
		]);
	});

	it("rolls 256+1 references by recency and is stable across retry", () => {
		const existing: CompactionContentManifest = {
			schemaVersion: 1,
			contentRefs: Array.from({ length: 256 }, (_, index) =>
				manifestEntry(`doc-${String(index).padStart(3, "0")}`),
			),
			modifiedFiles: [],
			pendingProcesses: [],
		};
		const newest = manifest("doc-newest", {
			lastUsedAt: "2026-08-21T22:00:00.000Z",
		});

		const first = mergeSessionSummaryMetadata(
			metadataWithManifest(existing),
			[],
			[newest],
		);
		const firstManifest = parseSessionSummaryContentManifest(first);
		const retry = mergeSessionSummaryMetadata(first, [], [newest]);

		expect(firstManifest?.contentRefs).toHaveLength(256);
		expect(
			firstManifest?.contentRefs.some(
				(entry) => entry.reference.ref === "doc-newest",
			),
		).toBe(true);
		expect(
			firstManifest?.contentRefs.some(
				(entry) => entry.reference.ref === "doc-255",
			),
		).toBe(false);
		expect(rolloverCounters(first).omittedReferences).toBe(1);
		expect(renderSessionSummaryContentManifest(first)).toContain(
			"bounded-ledger rollover high-water: references=1",
		);
		expect(retry).toEqual(first);
	});

	it("rolls 64+1 same-revision ranges without mixing or retry churn", () => {
		const existing = manifest("doc-ranges");
		const entry = existing.contentRefs[0];
		if (!entry) throw new Error("fixture manifest must contain a reference");
		entry.rangesUsed = Array.from({ length: 64 }, (_, index) => ({
			unit: "fragment" as const,
			start: index * 2,
			end: index * 2 + 1,
		}));
		const newest = manifest("doc-ranges", {
			start: 200,
			end: 201,
			lastUsedAt: "2026-08-21T22:00:00.000Z",
		});

		const first = mergeSessionSummaryMetadata(
			metadataWithManifest(existing),
			[],
			[newest],
		);
		const firstManifest = parseSessionSummaryContentManifest(first);
		const retry = mergeSessionSummaryMetadata(first, [], [newest]);

		expect(firstManifest?.contentRefs[0]?.rangesUsed).toHaveLength(64);
		expect(firstManifest?.contentRefs[0]?.rangesUsed).toContainEqual({
			unit: "fragment",
			start: 200,
			end: 201,
		});
		expect(rolloverCounters(first).omittedRanges).toBe(1);
		expect(retry).toEqual(first);
	});

	it("uses stable opaque-key ordering when reference timestamps tie", () => {
		const tied: CompactionContentManifest = {
			schemaVersion: 1,
			contentRefs: [
				manifestEntry("doc-c"),
				manifestEntry("doc-a"),
				manifestEntry("doc-b"),
			],
			modifiedFiles: [],
			pendingProcesses: [],
		};
		const merged = mergeSessionSummaryMetadata(
			undefined,
			[],
			[
				tied,
				{
					...tied,
					contentRefs: [],
				},
			],
		);

		expect(
			parseSessionSummaryContentManifest(merged)?.contentRefs.map(
				(entry) => entry.reference.ref,
			),
		).toEqual(["doc-a", "doc-b", "doc-c"]);
	});

	it("bounds modified files and pending processes with explicit counters", () => {
		const existing: CompactionContentManifest = {
			schemaVersion: 1,
			contentRefs: [],
			modifiedFiles: Array.from({ length: 256 }, (_, index) => ({
				reference: {
					kind: "file" as const,
					ref: `file-${String(index).padStart(3, "0")}`,
				},
			})),
			pendingProcesses: Array.from({ length: 128 }, (_, index) => ({
				id: `process-${String(index).padStart(3, "0")}`,
			})),
		};
		const incoming: CompactionContentManifest = {
			schemaVersion: 1,
			contentRefs: [],
			modifiedFiles: [{ reference: { kind: "file", ref: "file-newest" } }],
			pendingProcesses: [{ id: "process-newest" }],
		};

		const merged = mergeSessionSummaryMetadata(
			metadataWithManifest(existing),
			[],
			[incoming],
		);
		const persisted = parseSessionSummaryContentManifest(merged);

		expect(persisted?.modifiedFiles).toHaveLength(256);
		expect(persisted?.modifiedFiles).toContainEqual({
			reference: { kind: "file", ref: "file-newest" },
		});
		expect(persisted?.pendingProcesses).toHaveLength(128);
		expect(persisted?.pendingProcesses).toContainEqual({
			id: "process-newest",
		});
		expect(rolloverCounters(merged).omittedModifiedFiles).toBe(1);
		expect(rolloverCounters(merged).omittedPendingProcesses).toBe(1);
	});

	it("rejects tampered rollover counters beside a valid boundary manifest", () => {
		const boundary: CompactionContentManifest = {
			schemaVersion: 1,
			contentRefs: Array.from({ length: 256 }, (_, index) =>
				manifestEntry(`boundary-${index}`),
			),
			modifiedFiles: [],
			pendingProcesses: [],
		};
		const metadata = metadataWithManifest(boundary);
		progressiveEnvelope(metadata).rollover = {
			omittedReferences: -1,
			omittedRanges: 0,
			omittedModifiedFiles: 0,
			omittedPendingProcesses: 0,
		};

		expect(() => parseSessionSummaryContentManifest(metadata)).toThrow(
			/nonnegative safe integer/,
		);
	});

	it("rolls over valid inputs whose union crosses the byte boundary", () => {
		const nearBoundary = manifest("large-valid-entry", {
			reason: "x".repeat(261_800),
		});
		const newest = manifest("small-new-entry", {
			lastUsedAt: "2026-08-21T22:00:00.000Z",
		});

		const first = mergeSessionSummaryMetadata(
			metadataWithManifest(nearBoundary),
			[],
			[newest],
		);
		const persisted = parseSessionSummaryContentManifest(first);
		const retry = mergeSessionSummaryMetadata(first, [], [newest]);

		expect(persisted?.contentRefs.map((entry) => entry.reference.ref)).toEqual([
			"small-new-entry",
		]);
		expect(rolloverCounters(first).omittedReferences).toBe(1);
		expect(retry).toEqual(first);
	});
});

describe("session-summary content manifest rendering", () => {
	it("renders opaque handles and ranges but never the untrusted reason/body", () => {
		const metadata = metadataWithManifest(
			manifest("opaque-doc-1", {
				reason: "SOURCE BODY MUST NOT ENTER THE PROMPT",
			}),
		);

		const rendered = renderSessionSummaryContentManifest(metadata);

		expect(rendered).toContain("document:opaque-doc-1@rev-1");
		expect(rendered).toContain("fragment:0-2");
		expect(rendered).toContain("source bodies omitted");
		expect(rendered).not.toContain("SOURCE BODY MUST NOT ENTER THE PROMPT");
		expect(rendered.toLowerCase()).not.toContain("compaction");
	});

	it("bounds both entry count and final rendered characters", () => {
		const many: CompactionContentManifest = {
			schemaVersion: 1,
			contentRefs: Array.from({ length: 5 }, (_, index) =>
				manifestEntry(`doc-${index}`),
			),
			modifiedFiles: [],
			pendingProcesses: [],
		};
		const rendered = renderSessionSummaryContentManifest(
			metadataWithManifest(many),
			{ maxReferences: 2, maxCharacters: 180 },
		);

		expect(rendered).toContain("doc-0");
		expect(rendered).toContain("doc-1");
		expect(rendered).not.toContain("doc-2");
		expect(rendered.length).toBeLessThanOrEqual(180);
	});
});
