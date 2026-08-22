/**
 * Verifies that persisted compaction manifests accept only bounded,
 * model-safe reference metadata and reject hostile or ambiguous shapes.
 */

import { describe, expect, it } from "vitest";
import { validateCompactionContentManifest } from "./content-manifest";

const baseManifest = {
	schemaVersion: 1,
	contentRefs: [
		{
			reference: { kind: "document", ref: "document-opaque", revision: "r1" },
			revision: "r1",
			reason: "tool:DOCUMENT",
			rangesUsed: [{ unit: "fragment", start: 4, end: 7 }],
			lastUsedAt: "2026-08-22T12:00:00.000Z",
			retained: true,
		},
	],
	modifiedFiles: [],
	pendingProcesses: [],
};

describe("validateCompactionContentManifest", () => {
	it("accepts the versioned reference/range schema", () => {
		expect(validateCompactionContentManifest(baseManifest)).toEqual(
			baseManifest,
		);
	});

	it("rejects native paths and unknown fields", () => {
		expect(() =>
			validateCompactionContentManifest({
				...baseManifest,
				contentRefs: [
					{
						...baseManifest.contentRefs[0],
						reference: { kind: "file", ref: "/private/secret.txt" },
					},
				],
			}),
		).toThrow(/opaque token/u);
		expect(() =>
			validateCompactionContentManifest({
				...baseManifest,
				rawSummary: "do not persist me",
			}),
		).toThrow(/unsupported field/u);
	});

	it("rejects revision mismatches and excessive range ledgers", () => {
		expect(() =>
			validateCompactionContentManifest({
				...baseManifest,
				contentRefs: [
					{
						...baseManifest.contentRefs[0],
						revision: "r2",
					},
				],
			}),
		).toThrow(/revision mismatch/u);
		expect(() =>
			validateCompactionContentManifest({
				...baseManifest,
				contentRefs: [
					{
						...baseManifest.contentRefs[0],
						rangesUsed: Array.from({ length: 65 }, (_, index) => ({
							unit: "byte",
							start: index,
							end: index + 1,
						})),
					},
				],
			}),
		).toThrow(/too many ranges/u);
	});

	it("rejects duplicate locators, cross-entry conflicts, and modified-file mismatches", () => {
		expect(() =>
			validateCompactionContentManifest({
				...baseManifest,
				contentRefs: [
					baseManifest.contentRefs[0],
					{
						...baseManifest.contentRefs[0],
						revision: "r2",
						reference: {
							...baseManifest.contentRefs[0].reference,
							revision: "r2",
						},
					},
				],
			}),
		).toThrow(/conflicting revisions/u);
		expect(() =>
			validateCompactionContentManifest({
				...baseManifest,
				modifiedFiles: [
					{
						reference: { kind: "file", ref: "opaque-file", revision: "r1" },
						revision: "r2",
					},
				],
			}),
		).toThrow(/modified file reference revision mismatch/u);
	});
});
