/**
 * Builds and validates immutable UTF-8 document source segments, then
 * reconstructs one bounded byte, line, or fragment page from authorized rows.
 * The module is browser-safe and never materializes source outside the rows a
 * storage adapter already selected.
 */
import { v4 as uuidv4 } from "uuid";
import { ElizaError } from "../../errors";
import type {
	Content,
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
export const DOCUMENT_PARENT_INLINE_MAX_BYTES = 64 * 1024;

interface UnitRange {
	start: number;
	end: number;
}

export interface DocumentSourceReadMetadata {
	documentRevision: number;
	revisionAttemptId?: string;
	sourceByteLength: number;
	sourceLineCount: number;
	sourceFragmentCount: number;
	sourceFingerprint: string;
}

export interface DocumentSourceProjection {
	metadata: Required<
		Pick<
			DocumentMemoryMetadata,
			| "sourceSegmentVersion"
			| "sourceSegmentCount"
			| "sourceByteLength"
			| "sourceLineCount"
			| "sourceFragmentCount"
			| "sourceSha256"
			| "sourceFingerprint"
			| "sourceStorage"
		>
	>;
	segments: Memory[];
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function bytes(value: string): Uint8Array {
	return encoder.encode(value);
}

function byteLength(value: string): number {
	return bytes(value).length;
}

function lines(value: string): string[] {
	return value.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu) ?? [];
}

function units(value: string, unit: "line" | "fragment"): string[] {
	const sourceLines = lines(value);
	if (unit === "line") return sourceLines;
	return sourceLines
		.reduce<string[]>((fragments, line) => {
			const last = fragments.length - 1;
			if (last < 0) fragments.push(line);
			else fragments[last] += line;
			if (line.replace(/[\r\n]/gu, "").trim().length === 0) fragments.push("");
			return fragments;
		}, [])
		.filter((fragment) => fragment.length > 0);
}

function ranges(value: string, unit: "line" | "fragment"): UnitRange[] {
	let offset = 0;
	return units(value, unit).map((text) => {
		const start = offset;
		offset += byteLength(text);
		return { start, end: offset };
	});
}

function intersectingRange(
	unitRanges: UnitRange[],
	start: number,
	end: number,
): { start: number; end: number } {
	let first = unitRanges.findIndex((range) => range.end > start);
	if (first < 0) first = unitRanges.length;
	let last = first;
	while (last < unitRanges.length && unitRanges[last].start < end) last++;
	return { start: first, end: last };
}

function safeUtf8End(source: Uint8Array, start: number): number {
	let end = Math.min(start + DOCUMENT_SOURCE_SEGMENT_MAX_BYTES, source.length);
	while (end > start && end < source.length && (source[end] & 0xc0) === 0x80)
		end--;
	if (end === start) throw new Error("Unable to find a UTF-8 source boundary");
	return end;
}

export function projectDocumentParentContent(args: {
	text: string;
	projection: Pick<
		DocumentSourceProjection["metadata"],
		"sourceByteLength" | "sourceFingerprint" | "sourceStorage"
	>;
}): Content {
	if (args.projection.sourceByteLength <= DOCUMENT_PARENT_INLINE_MAX_BYTES) {
		return { text: args.text };
	}
	return {
		documentSource: {
			kind: "document-source",
			storage: "segments",
			byteLength: args.projection.sourceByteLength,
			fingerprint: args.projection.sourceFingerprint,
		},
	};
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
	const source = bytes(args.text);
	const lineRanges = ranges(args.text, "line");
	const fragmentRanges = ranges(args.text, "fragment");
	const digest = createHash("sha256").update(source).digest("hex");
	const segments: Memory[] = [];
	for (let start = 0, position = 0; start < source.length; position++) {
		const end = safeUtf8End(source, start);
		const line = intersectingRange(lineRanges, start, end);
		const fragment = intersectingRange(fragmentRanges, start, end);
		const metadata: DocumentFragmentMemoryMetadata = {
			...args.documentMetadata,
			type: MemoryType.FRAGMENT,
			documentId: args.documentId,
			fragmentRole: "source-segment",
			position,
			sourceSegmentVersion: DOCUMENT_SOURCE_SEGMENT_VERSION,
			sourceSegmentSha256: createHash("sha256")
				.update(source.subarray(start, end))
				.digest("hex"),
			sourceByteStart: start,
			sourceByteEnd: end,
			sourceLineStart: line.start,
			sourceLineEnd: line.end,
			sourceLineStartBoundary: lineRanges[line.start]?.start === start,
			sourceLineEndBoundary: lineRanges[line.end - 1]?.end === end,
			sourceFragmentStart: fragment.start,
			sourceFragmentEnd: fragment.end,
			sourceFragmentStartBoundary:
				fragmentRanges[fragment.start]?.start === start,
			sourceFragmentEndBoundary: fragmentRanges[fragment.end - 1]?.end === end,
			timestamp: Date.now(),
		};
		segments.push({
			id: uuidv4() as UUID,
			agentId: args.agentId,
			roomId: args.roomId,
			entityId: args.entityId,
			worldId: args.worldId,
			content: { text: decoder.decode(source.subarray(start, end)) },
			metadata,
		});
		start = end;
	}
	return {
		metadata: {
			sourceSegmentVersion: DOCUMENT_SOURCE_SEGMENT_VERSION,
			sourceSegmentCount: segments.length,
			sourceByteLength: source.length,
			sourceLineCount: lineRanges.length,
			sourceFragmentCount: fragmentRanges.length,
			sourceSha256: digest,
			sourceFingerprint: `sha256:${digest}`,
			sourceStorage:
				source.length <= DOCUMENT_PARENT_INLINE_MAX_BYTES
					? "inline"
					: "segments",
		},
		segments,
	};
}

function safeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

export function requireDocumentSourceReadMetadata(
	metadata: Record<string, unknown>,
	documentId: UUID,
): DocumentSourceReadMetadata {
	if (metadata.sourceSegmentVersion !== DOCUMENT_SOURCE_SEGMENT_VERSION) {
		throw new ElizaError(
			"Document must be explicitly reindexed before bounded reading",
			{
				code: "DOCUMENT_REINDEX_REQUIRED",
				context: {
					documentId,
					sourceSegmentVersion: metadata.sourceSegmentVersion ?? null,
				},
			},
		);
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

function coordinate(
	metadata: Record<string, unknown>,
	unit: "line" | "fragment",
	boundary: "Start" | "End",
): number | null {
	return safeNumber(
		metadata[`source${unit === "line" ? "Line" : "Fragment"}${boundary}`],
	);
}

function concat(chunks: Uint8Array[]): Uint8Array {
	const result = new Uint8Array(
		chunks.reduce((total, chunk) => total + chunk.length, 0),
	);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

export function readDocumentSourceProjection(args: {
	segments: Memory[];
	params: Pick<DocumentRangeReadParams, "unit" | "offset" | "limit">;
	parent: DocumentSourceReadMetadata;
	documentId: UUID;
	examinedSourceSegments?: number;
	sourceQueryCount: number;
}): DocumentRangeReadResult {
	const total =
		args.params.unit === "byte"
			? args.parent.sourceByteLength
			: args.params.unit === "line"
				? args.parent.sourceLineCount
				: args.parent.sourceFragmentCount;
	if (args.params.offset > total) {
		throw new ElizaError("Document source offset exceeds the retained source", {
			code: "DOCUMENT_RANGE_INVALID",
			context: {
				documentId: args.documentId,
				unit: args.params.unit,
				offset: args.params.offset,
				total,
			},
		});
	}
	const ordered = [...args.segments].sort(
		(left, right) =>
			(safeNumber(
				(left.metadata as Record<string, unknown>)?.sourceByteStart,
			) ?? -1) -
			(safeNumber(
				(right.metadata as Record<string, unknown>)?.sourceByteStart,
			) ?? -1),
	);
	if (ordered.length > DOCUMENT_SOURCE_READ_LOOKAHEAD_SEGMENTS) {
		throw new ElizaError("Document source read exceeded bounded lookahead", {
			code: "DOCUMENT_SOURCE_CORRUPT",
			context: { documentId: args.documentId, rows: ordered.length },
		});
	}
	let previousEnd: number | undefined;
	let previousPosition: number | undefined;
	for (const segment of ordered) {
		const metadata = (segment.metadata ?? {}) as Record<string, unknown>;
		const start = safeNumber(metadata.sourceByteStart);
		const end = safeNumber(metadata.sourceByteEnd);
		const position = safeNumber(metadata.position);
		const text = segment.content.text;
		if (
			metadata.fragmentRole !== "source-segment" ||
			metadata.sourceSegmentVersion !== DOCUMENT_SOURCE_SEGMENT_VERSION ||
			start === null ||
			end === null ||
			end <= start ||
			position === null ||
			typeof text !== "string" ||
			byteLength(text) !== end - start ||
			typeof metadata.sourceSegmentSha256 !== "string" ||
			createHash("sha256").update(text).digest("hex") !==
				metadata.sourceSegmentSha256 ||
			(previousEnd !== undefined && start !== previousEnd) ||
			(previousPosition !== undefined && position !== previousPosition + 1)
		) {
			throw new ElizaError("Canonical document source segments are invalid", {
				code: "DOCUMENT_SOURCE_CORRUPT",
				context: { documentId: args.documentId, position },
			});
		}
		previousEnd = end;
		previousPosition = position;
	}
	const common = {
		documentRevision: args.parent.documentRevision,
		...(args.parent.revisionAttemptId
			? { revisionAttemptId: args.parent.revisionAttemptId }
			: {}),
		sourceFingerprint: args.parent.sourceFingerprint,
		examinedSourceSegments: args.examinedSourceSegments ?? ordered.length,
		sourceQueryCount: args.sourceQueryCount,
	};
	const bytePage = (start: number, limit: number): DocumentRangeReadResult => {
		const requestedEnd = Math.min(start + limit, args.parent.sourceByteLength);
		const rows = ordered
			.filter((segment) => {
				const metadata = segment.metadata as Record<string, unknown>;
				const rowStart = safeNumber(metadata.sourceByteStart);
				const rowEnd = safeNumber(metadata.sourceByteEnd);
				return (
					rowStart !== null &&
					rowEnd !== null &&
					rowEnd > start &&
					rowStart < requestedEnd
				);
			})
			.slice(0, DOCUMENT_SOURCE_READ_MAX_SEGMENTS);
		if (start < args.parent.sourceByteLength && rows.length === 0) {
			throw new ElizaError("Document source byte range is missing", {
				code: "DOCUMENT_SOURCE_CORRUPT",
				context: { documentId: args.documentId, start },
			});
		}
		const firstStart =
			safeNumber(
				(rows[0]?.metadata as Record<string, unknown>)?.sourceByteStart,
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
		const selected = concat(rows.map((row) => bytes(row.content.text ?? "")));
		let localEnd = Math.min(localStart + requestedEnd - start, selected.length);
		if (
			localStart < selected.length &&
			(selected[localStart] & 0xc0) === 0x80
		) {
			throw new ElizaError("Document byte offset splits a UTF-8 sequence", {
				code: "DOCUMENT_READ_INVALID_UTF8_BOUNDARY",
				context: { documentId: args.documentId, offset: start },
			});
		}
		while (
			localEnd > localStart &&
			localEnd < selected.length &&
			(selected[localEnd] & 0xc0) === 0x80
		) {
			localEnd--;
		}
		if (localEnd === localStart && start < args.parent.sourceByteLength) {
			throw new ElizaError("Document byte limit splits a UTF-8 sequence", {
				code: "DOCUMENT_READ_INVALID_UTF8_BOUNDARY",
				context: { documentId: args.documentId, offset: start, limit },
			});
		}
		const pageBytes = selected.subarray(localStart, localEnd);
		let text: string;
		try {
			text = decoder.decode(pageBytes);
		} catch (cause) {
			// error-policy:J2 Preserve decoder evidence behind the typed read failure.
			throw new ElizaError("Document byte range is not valid UTF-8", {
				code: "DOCUMENT_READ_INVALID_UTF8_BOUNDARY",
				context: { documentId: args.documentId, offset: start },
				cause,
			});
		}
		return {
			unit: "byte",
			text,
			start,
			end: start + pageBytes.length,
			total: args.parent.sourceByteLength,
			...common,
			returnedSourceSegments: rows.length,
			returnedSourceBytes: pageBytes.length,
		};
	};
	if (args.params.unit === "byte")
		return bytePage(args.params.offset, args.params.limit);
	const unit = args.params.unit;
	const unitTotal =
		unit === "line"
			? args.parent.sourceLineCount
			: args.parent.sourceFragmentCount;
	const requestedEnd = Math.min(
		args.params.offset + args.params.limit,
		unitTotal,
	);
	const rows = ordered.filter((segment) => {
		const metadata = segment.metadata as Record<string, unknown>;
		const start = coordinate(metadata, unit, "Start");
		const end = coordinate(metadata, unit, "End");
		return (
			start !== null &&
			end !== null &&
			end > args.params.offset &&
			start < requestedEnd
		);
	});
	if (args.params.offset < unitTotal && rows.length === 0) {
		throw new ElizaError("Document source unit range is missing", {
			code: "DOCUMENT_SOURCE_CORRUPT",
			context: {
				documentId: args.documentId,
				unit,
				offset: args.params.offset,
			},
		});
	}
	const first = rows[0];
	const firstMetadata = (first?.metadata ?? {}) as Record<string, unknown>;
	const firstUnit = first
		? coordinate(firstMetadata, unit, "Start")
		: args.params.offset;
	const boundaryPrefix = unit === "line" ? "sourceLine" : "sourceFragment";
	if (
		firstUnit === null ||
		firstUnit > args.params.offset ||
		(rows.length > 0 &&
			firstUnit === args.params.offset &&
			firstMetadata[`${boundaryPrefix}StartBoundary`] !== true)
	) {
		throw new ElizaError("Document source unit prefix is missing", {
			code: "DOCUMENT_SOURCE_CORRUPT",
			context: {
				documentId: args.documentId,
				unit,
				offset: args.params.offset,
			},
		});
	}
	if (rows.length > DOCUMENT_SOURCE_READ_MAX_SEGMENTS) {
		const skipped = units(first?.content.text ?? "", unit)
			.slice(0, args.params.offset - firstUnit)
			.join("");
		const firstByte = safeNumber(firstMetadata.sourceByteStart) ?? 0;
		return bytePage(
			firstByte + byteLength(skipped),
			(DOCUMENT_SOURCE_READ_MAX_SEGMENTS - 1) *
				DOCUMENT_SOURCE_SEGMENT_MAX_BYTES,
		);
	}
	const lastMetadata = (rows.at(-1)?.metadata ?? {}) as Record<string, unknown>;
	const lastUnit = rows.length
		? coordinate(lastMetadata, unit, "End")
		: args.params.offset;
	if (
		lastUnit === null ||
		lastUnit < requestedEnd ||
		(rows.length > 0 &&
			lastUnit === requestedEnd &&
			lastMetadata[`${boundaryPrefix}EndBoundary`] !== true)
	) {
		throw new ElizaError("Document source unit range is incomplete", {
			code: "DOCUMENT_SOURCE_CORRUPT",
			context: {
				documentId: args.documentId,
				unit,
				offset: args.params.offset,
				requestedEnd,
			},
		});
	}
	const pageText = units(
		rows.map((row) => row.content.text ?? "").join(""),
		unit,
	)
		.slice(args.params.offset - firstUnit, requestedEnd - firstUnit)
		.join("");
	return {
		unit,
		text: pageText,
		start: args.params.offset,
		end: requestedEnd,
		total: unitTotal,
		...common,
		returnedSourceSegments: rows.length,
		returnedSourceBytes: byteLength(pageText),
	};
}
