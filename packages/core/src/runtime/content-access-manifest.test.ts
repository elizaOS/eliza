/**
 * Exercises the deterministic compaction content manifest against real
 * progressive-read contracts, including archive survival and strict bounds.
 */

import { describe, expect, it } from "vitest";
import type { ElizaError } from "../errors";
import { buildReadSlice, buildReadView } from "../types/content";
import { deriveCompactionContentManifest } from "./content-access-manifest";

const digest = "a".repeat(64);

function readView(start: number, end: number) {
	return buildReadView({
		reference: { kind: "file", ref: "opaque-file", revision: "rev-1" },
		slice: buildReadSlice({
			range: { unit: "byte", start, end, total: 100 },
			completeness: end < 100 ? "partial-recoverable" : "complete",
			sliceSha256: digest,
			revision: "rev-1",
		}),
	});
}

describe("deriveCompactionContentManifest", () => {
	it("deduplicates ranges and preserves archived continuation metadata", () => {
		const manifest = deriveCompactionContentManifest(
			{
				archivedSteps: [
					{
						iteration: 1,
						toolCall: { name: "FILE" },
						result: {
							success: true,
							text: "source bytes never enter the manifest",
							promptData: { readView: readView(0, 20) },
						},
					},
				],
				steps: [
					{
						iteration: 2,
						toolCall: { name: "FILE" },
						result: {
							success: true,
							promptData: {
								first: readView(0, 20),
								second: readView(20, 40),
							},
						},
					},
				],
			},
			{ lastUsedAt: "2026-08-22T12:00:00.000Z" },
		);

		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.contentRefs).toEqual([
			{
				reference: {
					kind: "file",
					ref: "opaque-file",
					revision: "rev-1",
				},
				revision: "rev-1",
				reason: "tool:FILE",
				rangesUsed: [
					{ unit: "byte", start: 0, end: 20 },
					{ unit: "byte", start: 20, end: 40 },
				],
				lastUsedAt: "2026-08-22T12:00:00.000Z",
				retained: true,
			},
		]);
		expect(JSON.stringify(manifest)).not.toContain("source bytes");
	});

	it("fails explicitly instead of silently truncating the manifest", () => {
		expect(() =>
			deriveCompactionContentManifest(
				{
					archivedSteps: [],
					steps: [
						{
							iteration: 1,
							result: {
								success: true,
								promptData: {
									a: readView(0, 20),
									b: readView(20, 40),
								},
							},
						},
					],
				},
				{
					lastUsedAt: "2026-08-22T12:00:00.000Z",
					maxRangesPerReference: 1,
				},
			),
		).toThrowError(
			expect.objectContaining<Partial<ElizaError>>({
				code: "CONTENT_MANIFEST_BOUND_EXCEEDED",
			}),
		);
	});

	it("rejects conflicting revisions for one native reference", () => {
		const secondRevision = {
			...readView(20, 40),
			reference: {
				kind: "file" as const,
				ref: "opaque-file",
				revision: "rev-2",
			},
			slice: { ...readView(20, 40).slice, revision: "rev-2" },
		};
		expect(() =>
			deriveCompactionContentManifest(
				{
					archivedSteps: [
						{
							iteration: 1,
							result: {
								success: true,
								promptData: { readView: readView(0, 20) },
							},
						},
					],
					steps: [
						{
							iteration: 2,
							result: {
								success: true,
								promptData: { readView: secondRevision },
							},
						},
					],
				},
				{ lastUsedAt: "2026-08-22T12:00:00.000Z" },
			),
		).toThrow(/conflicting source revisions/u);
	});

	it("rejects an object beyond the traversal depth instead of losing it", () => {
		const nested = { a: { b: { c: { readView: readView(0, 20) } } } };
		expect(() =>
			deriveCompactionContentManifest(
				{
					archivedSteps: [],
					steps: [
						{ iteration: 1, result: { success: true, promptData: nested } },
					],
				},
				{ lastUsedAt: "2026-08-22T12:00:00.000Z", maxDepth: 2 },
			),
		).toThrow(/depth bound/u);
	});
});
