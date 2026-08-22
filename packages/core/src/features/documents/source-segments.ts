/**
 * Builds the canonical, lossless UTF-8 source projection used by bounded
 * document reads. Source segments are immutable, non-overlapping byte ranges;
 * embedding chunks remain a separate derived projection.
 */
import { v4 as uuidv4 } from "uuid";
import { ElizaError } from "../../errors";
import type {
	DocumentRangeReadParams,
	DocumentRangeReadResult,
	Memory,
	UUID,
} from "../../types";
import { MemoryType } from "../../types";
import { createHash } from "../../utils/crypto-compat";
import type {
	DocumentFragmentMemoryMetadata,
	DocumentMemoryMetadata,
} from "./types";

export const DOCUMENT_SOURCE_SEGMENT_VERSION = 1 as const;
export const DOCUMENT_SOURCE_SEGMENT_MAX_BYTES = 64 * 1024;
export const DOCUMENT_SOURCE_READ_MAX_SEGMENTS = 4;
export const DOCUMENT_SOURCE_READ_LOOKAHEAD_SEGMENTS =
	DOCUMENT_SOURCE_READ_MAX_SEGMENTS + 1;

export interface DocumentSourceProjection {
	metadata: Pick<
		DocumentMemoryMetadata,
		| "sourceSegmentVersion"
		| "sourceSegmentCount"
		| "sourceByteLength"
		| "sourceLineCount"
		| "sourceFragmentCount"
		| "sourceSha256"
		| "sourceFingerprint"
	>;
	segments: Memory[];
}

interface UnitRange {
	start: number;
	end: number;
}

function sourceUnits(text: string, unit: "line" | "fragment"): string[] {
	const lines = text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu) ?? [];
	if (unit === "line") return lines;
	return lines
		.reduce<string[]>((fragments, line) => {
			const last = fragments.length - 1;
			if (last < 0) fragments.push(line);
			else fragments[last] += line;
			if (line.replace(/[\r\n]/gu, "").trim().length === 0) {
				fragments.push("");
			}
			return fragments;
		}, [])
		.filter((fragment) => fragment.length > 0);
}

function unitRanges(text: string, unit: "line" | "fragment"): UnitRange[] {
	let byteOffset = 0;
	return sourceUnits(text, unit).map((value) => {
		const start = byteOffset;
		byteOffset += Buffer.byteLength(value, "utf8");
		return { start, end: byteOffset };
	});
}

function intersectingUnitRange(
	units: UnitRange[],
	segmentStart: number,
	segmentEnd: number,
): { start: number; end: number } {
	let low = 0;
	let high = units.length;
	while (low < high) {
		const middle = low + Math.floor((high - low) / 2);
		if (units[middle].end <= segmentStart) low = middle + 1;
		else high = middle;
	}
	const start = low;
	let end = start;
	while (end < units.length && units[end].start < segmentEnd) end++;
	return { start, end };
}

function safeUtf8End(bytes: Buffer, start: number): number {
	let end = Math.min(start + DOCUMENT_SOURCE_SEGMENT_MAX_BYTES, bytes.length);
	while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) {
		end--;
	}
	if (end === start) {
		throw new Error(
			"Unable to find a UTF-8 boundary inside source segment limit",
		);
	}
	return end;
}

export function buildDocumentSourceProjection(args: {
	text: string;
	documentId: UUID;
	agentId: UUID;
	roomId: UUID;
	entityId: UUID;
	worldId?: UUID;
	documentMetadata: DocumentMemoryMetadata;
}): DocumentSourceProjection {
	const bytes = Buffer.from(args.text, "utf8");
	const lineRanges = unitRanges(args.text, "line");
	const fragmentRanges = unitRanges(args.text, "fragment");
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	const segments: Memory[] = [];
	for (let start = 0, ordinal = 0; start < bytes.length; ordinal++) {
		const end = safeUtf8End(bytes, start);
		const line = intersectingUnitRange(lineRanges, start, end);
		const fragment = intersectingUnitRange(fragmentRanges, start, end);
		const metadata: DocumentFragmentMemoryMetadata = {
			...args.documentMetadata,
			type: MemoryType.FRAGMENT,
			documentId: args.documentId,
			fragmentRole: "source-segment",
			position: ordinal,
			sourceSegmentVersion: DOCUMENT_SOURCE_SEGMENT_VERSION,
			sourceSegmentSha256: createHash("sha256")
				.update(bytes.subarray(start, end))
				.digest("hex"),
			sourceByteStart: start,
			sourceByteEnd: end,
			sourceLineStart: line.start,
			sourceLineEnd: line.end,
			sourceFragmentStart: fragment.start,
			sourceFragmentEnd: fragment.end,
			timestamp: Date.now(),
		};
		segments.push({
			id: uuidv4() as UUID,
			agentId: args.agentId,
			roomId: args.roomId,
			entityId: args.entityId,
			worldId: args.worldId,
			content: { text: bytes.subarray(start, end).toString("utf8") },
			metadata,
		});
		start = end;
	}
	return {
		metadata: {
			sourceSegmentVersion: DOCUMENT_SOURCE_SEGMENT_VERSION,
			sourceSegmentCount: segments.length,
			sourceByteLength: bytes.length,
			sourceLineCount: lineRanges.length,
			sourceFragmentCount: fragmentRanges.length,
			sourceSha256: sha256,
			sourceFingerprint: `sha256:${sha256}`,
		},
		segments,
	};
}

export function splitDocumentSourceUnits(
	text: string,
	unit: "line" | "fragment",
): string[] {
	return sourceUnits(text, unit);
}

function safeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

export interface DocumentSourceReadMetadata {
	documentRevision: number;
	revisionAttemptId?: string;
	sourceByteLength: number;
	sourceLineCount: number;
	sourceFragmentCount: number;
	sourceFingerprint: string;
}

/**
 * Validates the parent-only metadata required for bounded reads. An authorized
 * legacy row receives an actionable migration error; malformed segmented rows
 * are reported separately as corruption rather than being scanned as legacy.
 */
export function requireDocumentSourceReadMetadata(
	metadata: Record<string, unknown>,
	documentId: UUID,
): DocumentSourceReadMetadata {
	if (metadata.sourceSegmentVersion !== DOCUMENT_SOURCE_SEGMENT_VERSION) {
		throw new ElizaError("Document must be reindexed before bounded reading", {
			code: "DOCUMENT_REINDEX_REQUIRED",
			context: {
				documentId,
				sourceSegmentVersion: metadata.sourceSegmentVersion ?? null,
			},
		});
	}
	const documentRevision = safeNumber(metadata.documentRevision);
	const sourceByteLength = safeNumber(metadata.sourceByteLength);
	const sourceLineCount = safeNumber(metadata.sourceLineCount);
	const sourceFragmentCount = safeNumber(metadata.sourceFragmentCount);
	const sourceSegmentCount = safeNumber(metadata.sourceSegmentCount);
	if (
		documentRevision === null ||
		sourceByteLength === null ||
		sourceLineCount === null ||
		sourceFragmentCount === null ||
		sourceSegmentCount === null ||
		typeof metadata.sourceFingerprint !== "string" ||
		!/^sha256:[a-f0-9]{64}$/u.test(metadata.sourceFingerprint) ||
		(sourceByteLength > 0 && sourceSegmentCount === 0)
	) {
		throw new ElizaError("Canonical document source metadata is invalid", {
			code: "DOCUMENT_SOURCE_CORRUPT",
			context: { documentId },
		});
	}
	return {
		documentRevision,
		...(typeof metadata.revisionAttemptId === "string"
			? { revisionAttemptId: metadata.revisionAttemptId }
			: {}),
		sourceByteLength,
		sourceLineCount,
		sourceFragmentCount,
		sourceFingerprint: metadata.sourceFingerprint,
	};
}

function sourceCoordinate(
	metadata: Record<string, unknown>,
	unit: "line" | "fragment",
	boundary: "Start" | "End",
): number | null {
	return safeNumber(
		metadata[`source${unit === "line" ? "Line" : "Fragment"}${boundary}`],
	);
}

/**
 * Reassembles one bounded read from already-authorized source rows. Callers
 * must pass no more than MAX+1 coordinate-intersecting rows; the extra row is
 * the bounded overflow probe that triggers byte-coordinate continuation.
 */
export function readDocumentSourceProjection(args: {
	segments: Memory[];
	params: Pick<DocumentRangeReadParams, "unit" | "offset" | "limit">;
	parent: DocumentSourceReadMetadata;
	documentId: UUID;
	/** Number of rows returned by the bounded storage query, including lookahead. */
	examinedSourceSegments?: number;
	/** Constant storage-query count reported by the adapter. */
	sourceQueryCount: number;
}): DocumentRangeReadResult {
	const byteTotal = args.parent.sourceByteLength;
	const lineTotal = args.parent.sourceLineCount;
	const fragmentTotal = args.parent.sourceFragmentCount;
	const fingerprint = args.parent.sourceFingerprint;
	const ordered = [...args.segments].sort((left, right) => {
		const leftStart =
			safeNumber((left.metadata as Record<string, unknown>)?.sourceByteStart) ??
			-1;
		const rightStart =
			safeNumber(
				(right.metadata as Record<string, unknown>)?.sourceByteStart,
			) ?? -1;
		return leftStart - rightStart;
	});
	if (ordered.length > DOCUMENT_SOURCE_READ_LOOKAHEAD_SEGMENTS) {
		throw new ElizaError("Document source read exceeded bounded lookahead", {
			code: "DOCUMENT_SOURCE_CORRUPT",
			context: { documentId: args.documentId, rows: ordered.length },
		});
	}
	let previousEnd: number | undefined;
	let previousPosition: number | undefined;
	for (const segment of ordered) {
		const rowMetadata = (segment.metadata ?? {}) as Record<string, unknown>;
		const rowStart = safeNumber(rowMetadata.sourceByteStart);
		const rowEnd = safeNumber(rowMetadata.sourceByteEnd);
		const position = safeNumber(rowMetadata.position);
		const segmentSha256 = rowMetadata.sourceSegmentSha256;
		const text = segment.content.text;
		if (
			rowMetadata.fragmentRole !== "source-segment" ||
			rowMetadata.sourceSegmentVersion !== DOCUMENT_SOURCE_SEGMENT_VERSION ||
			rowStart === null ||
			rowEnd === null ||
			rowEnd <= rowStart ||
			position === null ||
			typeof text !== "string" ||
			Buffer.byteLength(text, "utf8") !== rowEnd - rowStart ||
			typeof segmentSha256 !== "string" ||
			!/^[a-f0-9]{64}$/u.test(segmentSha256) ||
			createHash("sha256").update(text).digest("hex") !== segmentSha256 ||
			(previousEnd !== undefined && rowStart !== previousEnd) ||
			(previousPosition !== undefined && position !== previousPosition + 1)
		) {
			throw new ElizaError("Canonical document source segments are invalid", {
				code: "DOCUMENT_SOURCE_CORRUPT",
				context: { documentId: args.documentId, position },
			});
		}
		previousEnd = rowEnd;
		previousPosition = position;
	}
	const examinedSourceSegments = args.examinedSourceSegments ?? ordered.length;
	const sourceBytesRead = ordered.reduce(
		(total, row) => total + Buffer.byteLength(row.content.text ?? "", "utf8"),
		0,
	);
	const common = {
		documentRevision: args.parent.documentRevision,
		...(args.parent.revisionAttemptId
			? { revisionAttemptId: args.parent.revisionAttemptId }
			: {}),
		sourceFingerprint: fingerprint,
		examinedSourceSegments,
		sourceQueryCount: args.sourceQueryCount,
		sourceBytesRead,
	};
	const bytePage = (
		start: number,
		requestedLimit: number,
	): DocumentRangeReadResult => {
		const requestedEnd = Math.min(start + requestedLimit, byteTotal);
		const rows = ordered.filter((segment) => {
			const rowMetadata = (segment.metadata ?? {}) as Record<string, unknown>;
			const rowStart = safeNumber(rowMetadata.sourceByteStart);
			const rowEnd = safeNumber(rowMetadata.sourceByteEnd);
			return (
				rowStart !== null &&
				rowEnd !== null &&
				rowEnd > start &&
				rowStart < requestedEnd
			);
		});
		if (start < byteTotal && rows.length === 0) {
			throw new ElizaError("Document source byte range is missing", {
				code: "DOCUMENT_SOURCE_CORRUPT",
				context: { documentId: args.documentId, start },
			});
		}
		const complete = rows.map((row) => row.content.text ?? "").join("");
		const firstStart =
			safeNumber(
				(rows[0]?.metadata as Record<string, unknown> | undefined)
					?.sourceByteStart,
			) ?? start;
		const localStart = start - firstStart;
		if (localStart < 0) {
			throw new ElizaError(
				"Document source byte range begins after its offset",
				{
					code: "DOCUMENT_SOURCE_CORRUPT",
					context: { documentId: args.documentId, start, firstStart },
				},
			);
		}
		const bytes = Buffer.from(complete, "utf8");
		let localEnd = Math.min(localStart + (requestedEnd - start), bytes.length);
		if (localStart < bytes.length && (bytes[localStart] & 0xc0) === 0x80) {
			throw new ElizaError("Document byte offset splits a UTF-8 sequence", {
				code: "DOCUMENT_READ_INVALID_UTF8_BOUNDARY",
				context: { documentId: args.documentId, offset: start },
			});
		}
		while (
			localEnd > localStart &&
			localEnd < bytes.length &&
			(bytes[localEnd] & 0xc0) === 0x80
		) {
			localEnd--;
		}
		if (localEnd === localStart && start < byteTotal) {
			throw new ElizaError("Document byte limit splits a UTF-8 sequence", {
				code: "DOCUMENT_READ_INVALID_UTF8_BOUNDARY",
				context: { documentId: args.documentId, offset: start, requestedLimit },
			});
		}
		const pageBytes = bytes.subarray(localStart, localEnd);
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(pageBytes);
		} catch (cause) {
			// error-policy:J2 Preserve the decoder failure behind a typed range error.
			throw new ElizaError("Document byte range is not valid UTF-8", {
				code: "DOCUMENT_READ_INVALID_UTF8_BOUNDARY",
				context: { documentId: args.documentId, offset: start },
				cause,
			});
		}
		const returnedSourceBytes = pageBytes.length;
		return {
			unit: "byte",
			text,
			start,
			end: start + returnedSourceBytes,
			total: byteTotal,
			...common,
			returnedSourceSegments: rows.length,
			returnedSourceBytes,
		};
	};
	const unit = args.params.unit;
	if (unit === "byte") {
		return bytePage(args.params.offset, args.params.limit);
	}
	const total = unit === "line" ? lineTotal : fragmentTotal;
	const requestedEnd = Math.min(args.params.offset + args.params.limit, total);
	const rows = ordered.filter((segment) => {
		const rowMetadata = (segment.metadata ?? {}) as Record<string, unknown>;
		const start = sourceCoordinate(rowMetadata, unit, "Start");
		const end = sourceCoordinate(rowMetadata, unit, "End");
		return (
			start !== null &&
			end !== null &&
			end > args.params.offset &&
			start < requestedEnd
		);
	});
	if (rows.length > DOCUMENT_SOURCE_READ_MAX_SEGMENTS) {
		const first = rows[0];
		const firstMetadata = (first.metadata ?? {}) as Record<string, unknown>;
		const firstUnit =
			sourceCoordinate(firstMetadata, unit, "Start") ?? args.params.offset;
		const units = sourceUnits(first.content.text ?? "", unit);
		const skipped = units.slice(0, args.params.offset - firstUnit).join("");
		const firstByte = safeNumber(firstMetadata.sourceByteStart) ?? 0;
		return bytePage(
			firstByte + Buffer.byteLength(skipped, "utf8"),
			(DOCUMENT_SOURCE_READ_MAX_SEGMENTS - 1) *
				DOCUMENT_SOURCE_SEGMENT_MAX_BYTES,
		);
	}
	if (args.params.offset < total && rows.length === 0) {
		throw new ElizaError("Document source unit range is missing", {
			code: "DOCUMENT_SOURCE_CORRUPT",
			context: {
				documentId: args.documentId,
				unit,
				offset: args.params.offset,
			},
		});
	}
	const firstUnit = rows.length
		? (sourceCoordinate(
				(rows[0].metadata ?? {}) as Record<string, unknown>,
				unit,
				"Start",
			) ?? args.params.offset)
		: args.params.offset;
	const units = sourceUnits(
		rows.map((row) => row.content.text ?? "").join(""),
		unit,
	);
	const pageText = units
		.slice(args.params.offset - firstUnit, requestedEnd - firstUnit)
		.join("");
	return {
		unit,
		text: pageText,
		start: args.params.offset,
		end: requestedEnd,
		total,
		...common,
		returnedSourceSegments: rows.length,
		returnedSourceBytes: Buffer.byteLength(pageText, "utf8"),
	};
}
