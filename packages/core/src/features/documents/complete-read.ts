/** Assembles authorized document pages without exposing partial or mixed-revision content. */
import { ElizaError } from "../../errors";
import type {
	DocumentRangeReadParams,
	DocumentRangeReadResult,
} from "../../types";

type Range = Pick<DocumentRangeReadParams, "unit" | "offset" | "limit">;
export type DocumentReadOptions = Omit<Range, "limit"> & { limit?: number };

export async function readCompleteDocumentRange(
	options: DocumentReadOptions,
	readPage: (range: Range) => Promise<DocumentRangeReadResult | null>,
): Promise<DocumentRangeReadResult | null> {
	if (options.limit !== undefined)
		return readPage({ ...options, limit: options.limit });
	if (
		!Number.isSafeInteger(options.offset) ||
		options.offset < 0 ||
		options.offset >= Number.MAX_SAFE_INTEGER
	) {
		throw new ElizaError("Document read offset is invalid", {
			code: "DOCUMENT_READ_INVALID_RANGE",
		});
	}
	let page = await readPage({
		...options,
		limit: Number.MAX_SAFE_INTEGER - options.offset,
	});
	if (!page) return null;
	const first = page;
	if (
		(first.unit === options.unit && first.start !== options.offset) ||
		(first.unit !== options.unit && first.unit !== "byte")
	) {
		throw new ElizaError("Document page does not match the requested range", {
			code: "DOCUMENT_READ_INVALID_RANGE",
		});
	}
	const parts: string[] = [];
	let examinedSourceSegments = 0;
	let sourceQueryCount = 0;
	let returnedSourceSegments = 0;
	let returnedSourceBytes = 0;
	let expectedStart = first.start;
	while (true) {
		if (
			page.unit !== first.unit ||
			page.total !== first.total ||
			page.documentRevision !== first.documentRevision ||
			page.revisionAttemptId !== first.revisionAttemptId ||
			page.sourceFingerprint !== first.sourceFingerprint
		) {
			throw new ElizaError("Document changed during complete read", {
				code: "DOCUMENT_READ_REVISION_CHANGED",
			});
		}
		if (
			!Number.isSafeInteger(page.start) ||
			!Number.isSafeInteger(page.end) ||
			!Number.isSafeInteger(page.total) ||
			page.start !== expectedStart ||
			page.start < 0 ||
			page.end < page.start ||
			page.end > page.total ||
			(page.end === page.start && page.end < page.total)
		) {
			throw new ElizaError(
				"Document pagination did not make contiguous progress",
				{ code: "DOCUMENT_READ_INVALID_RANGE" },
			);
		}
		parts.push(page.text);
		examinedSourceSegments += page.examinedSourceSegments;
		sourceQueryCount += page.sourceQueryCount;
		returnedSourceSegments += page.returnedSourceSegments;
		returnedSourceBytes += page.returnedSourceBytes;
		if (page.end === page.total)
			return {
				...first,
				text: parts.join(""),
				end: page.end,
				examinedSourceSegments,
				sourceQueryCount,
				returnedSourceSegments,
				returnedSourceBytes,
			};
		expectedStart = page.end;
		const next = await readPage({
			unit: first.unit,
			offset: expectedStart,
			limit: Number.MAX_SAFE_INTEGER - expectedStart,
		});
		if (!next)
			throw new ElizaError("Document became unavailable during complete read", {
				code: "DOCUMENT_READ_UNAVAILABLE",
			});
		page = next;
	}
}
