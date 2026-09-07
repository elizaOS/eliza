/** Tests complete document assembly across bounded adapter pages and changing authorization or revisions. */
import { describe, expect, it } from "vitest";
import type { DocumentRangeReadResult } from "../../types";
import { readCompleteDocumentRange } from "./complete-read";

function page(
	start: number,
	text: string,
	total: number,
): DocumentRangeReadResult {
	return {
		unit: "byte",
		start,
		end: start + Buffer.byteLength(text),
		total,
		text,
		documentRevision: 1,
		sourceFingerprint: "revision-one",
		examinedSourceSegments: 1,
		sourceQueryCount: 1,
		returnedSourceSegments: 1,
		returnedSourceBytes: Buffer.byteLength(text),
	};
}

describe("complete document read", () => {
	it("reassembles every Unicode page after the native line-to-byte fallback", async () => {
		const pieces = ["first\n", "猫🙂\n", "last\n"];
		const text = pieces.join("");
		let index = 0;
		const result = await readCompleteDocumentRange(
			{ unit: "line", offset: 0 },
			async (range) =>
				page(range.offset, pieces[index++], Buffer.byteLength(text)),
		);
		expect(result?.text).toBe(text);
		expect(result?.end).toBe(Buffer.byteLength(text));
		expect(result?.sourceQueryCount).toBe(3);
	});

	it("returns only the requested bounded page when a limit is explicit", async () => {
		const result = await readCompleteDocumentRange(
			{ unit: "byte", offset: 2, limit: 3 },
			async (range) =>
				page(
					range.offset,
					"abcdef".slice(range.offset, range.offset + range.limit),
					6,
				),
		);
		expect(result?.text).toBe("cde");
		expect(result?.end).toBe(5);
	});

	it("preserves unavailable and empty document states", async () => {
		expect(
			await readCompleteDocumentRange(
				{ unit: "byte", offset: 0 },
				async () => null,
			),
		).toBeNull();
		expect(
			(
				await readCompleteDocumentRange({ unit: "byte", offset: 0 }, async () =>
					page(0, "", 0),
				)
			)?.text,
		).toBe("");
	});

	it.each([
		"documentRevision",
		"sourceFingerprint",
		"revisionAttemptId",
		"total",
	] as const)(
		"rejects a changed %s before exposing the earlier page",
		async (field) => {
			let calls = 0;
			await expect(
				readCompleteDocumentRange({ unit: "byte", offset: 0 }, async () => {
					if (calls++ === 0) return page(0, "a", 2);
					const next = page(1, "b", 2);
					if (field === "documentRevision") next.documentRevision = 2;
					if (field === "sourceFingerprint") next.sourceFingerprint = "changed";
					if (field === "revisionAttemptId") next.revisionAttemptId = "changed";
					if (field === "total") next.total = 3;
					return next;
				}),
			).rejects.toMatchObject({ code: "DOCUMENT_READ_REVISION_CHANGED" });
		},
	);

	it("rejects revocation between pages without returning a prefix", async () => {
		let calls = 0;
		await expect(
			readCompleteDocumentRange({ unit: "byte", offset: 0 }, async () =>
				calls++ === 0 ? page(0, "a", 2) : null,
			),
		).rejects.toMatchObject({ code: "DOCUMENT_READ_UNAVAILABLE" });
	});

	it.each([page(0, "a", 2), page(1, "", 2), page(2, "b", 3)])(
		"rejects noncontiguous or stalled continuation %#",
		async (next) => {
			let calls = 0;
			await expect(
				readCompleteDocumentRange({ unit: "byte", offset: 0 }, async () =>
					calls++ === 0 ? page(0, "a", 2) : { ...next, total: 2 },
				),
			).rejects.toMatchObject({ code: "DOCUMENT_READ_INVALID_RANGE" });
		},
	);
});
