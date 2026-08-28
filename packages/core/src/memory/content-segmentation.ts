/**
 * UTF-8 segmentation primitive for bounded native paging of large stored
 * MESSAGE text and extracted ATTACHMENT text (#25140). Pure logic, shared by
 * the SQL adapter (which publishes immutable, non-overlapping source segments
 * alongside a bounded parent descriptor) and by tests that verify exact SHA
 * reassembly. Boundaries are computed on UTF-8 bytes, never on JavaScript
 * string code units, so a segment never splits a code point and the
 * concatenation of segment bytes is byte-identical to the source.
 */
import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "../errors.ts";

/** Maximum byte length of one stored source segment. Must not split a code point. */
export const MEMORY_SEGMENT_BYTES = 128 * 1024;

/** Content whose UTF-8 byte length exceeds this threshold is segmented. */
export const MEMORY_SEGMENTATION_THRESHOLD_BYTES = 128 * 1024;

/**
 * Hard ceiling on the byte length a single page read may return, applied even
 * when a caller omits or oversizes `limit` (a read is never source-sized).
 */
export const MEMORY_PAGE_MAX_BYTES = 256 * 1024;

/** Field identity of segmented content on the parent memory. */
export type MemorySegmentField =
	| { kind: "content.text" }
	| { kind: "attachment.text"; attachmentId: string };

/** Stable metadata key for one segmented field on the parent memory. */
export function memorySegmentFieldKey(field: MemorySegmentField): string {
	return field.kind === "content.text"
		? "content.text"
		: `attachment.text:${field.attachmentId}`;
}

/** Bounded descriptor stored on the parent memory; never carries source bytes. */
export interface MemoryContentSegmentation {
	v: 1;
	field: MemorySegmentField;
	encoding: "utf-8";
	segmentBytes: number;
	totalBytes: number;
	totalSha256: string;
	segmentCount: number;
	/** Immutable generation identity; changes only on full replacement. */
	generation: string;
	/** Opaque public revision: identifies the immutable generation. */
	revision: string;
}

/** One computed source segment. `byteEnd` is exclusive. */
export interface ComputedMemorySegment {
	index: number;
	byteStart: number;
	byteEnd: number;
	text: string;
	sha256: string;
}

export interface ComputedSegmentation {
	segments: ComputedMemorySegment[];
	descriptor: MemoryContentSegmentation;
}

export class MemorySegmentationError extends ElizaError {
	constructor(
		message: string,
		code: string,
		context: Record<string, unknown> = {},
	) {
		super(message, { code, context });
	}
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Returns the byte offset of the start of the UTF-8 code point that contains
 * `offset` when `offset` lands inside a multibyte sequence: decrement until the
 * byte is not a continuation byte (0b10xxxxxx). A boundary-aligned offset is
 * returned unchanged.
 */
function snapToCodePointStart(bytes: Uint8Array, offset: number): number {
	let at = offset;
	while (at > 0 && (bytes[at] & 0xc0) === 0x80) {
		at -= 1;
	}
	return at;
}

/** Encodes text to UTF-8 bytes, failing closed on lone surrogates. */
export function encodeUtf8Strict(text: string): Uint8Array {
	const bytes = Buffer.from(text, "utf8");
	// Buffer.from replaces lone surrogates with U+FFFD; detect that corruption
	// by comparing a lossless round-trip of the decoded result.
	const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (decoded !== text) {
		throw new MemorySegmentationError(
			"Content contains unpaired surrogates and cannot be segmented losslessly",
			"MEMORY_SEGMENT_UNPAIRED_SURROGATE",
		);
	}
	return bytes;
}

/** Whether content must be segmented based on its UTF-8 byte length. */
export function shouldSegmentContent(text: string): boolean {
	return encodeUtf8Strict(text).length > MEMORY_SEGMENTATION_THRESHOLD_BYTES;
}

function randomGeneration(): string {
	return randomUUID();
}

/**
 * Splits `text` into immutable non-overlapping UTF-8 segments of at most
 * `segmentBytes` and returns them together with the bounded descriptor.
 * `generation` is minted here (or inherited on replacement) so the revision
 * identifies one immutable generation of the content.
 */
export function segmentMemoryContent(
	text: string,
	field: MemorySegmentField,
	options?: { segmentBytes?: number; generation?: string },
): ComputedSegmentation {
	const segmentBytes = options?.segmentBytes ?? MEMORY_SEGMENT_BYTES;
	if (
		!Number.isInteger(segmentBytes) ||
		segmentBytes < 4 ||
		segmentBytes > 4 * 1024 * 1024
	) {
		throw new MemorySegmentationError(
			"Segment byte budget is out of the supported range",
			"MEMORY_SEGMENT_INVALID_BUDGET",
			{ segmentBytes },
		);
	}
	const bytes = encodeUtf8Strict(text);
	const totalBytes = bytes.length;
	if (totalBytes === 0) {
		throw new MemorySegmentationError(
			"Empty content is never segmented",
			"MEMORY_SEGMENT_EMPTY_SOURCE",
		);
	}
	const totalSha256 = sha256Hex(bytes);
	const generation = options?.generation ?? randomGeneration();

	const segments: ComputedMemorySegment[] = [];
	let start = 0;
	let index = 0;
	while (start < totalBytes) {
		let end = Math.min(start + segmentBytes, totalBytes);
		end = snapToCodePointStart(bytes, end);
		if (end <= start) {
			// A single code point larger than the budget cannot exist in UTF-8
			// (max 4 bytes) with segmentBytes >= 4, so this is unreachable.
			throw new MemorySegmentationError(
				"Segment budget cannot make progress at this offset",
				"MEMORY_SEGMENT_BUDGET_TOO_SMALL",
				{ start, segmentBytes },
			);
		}
		const segmentBytesSlice = bytes.subarray(start, end);
		segments.push({
			index,
			byteStart: start,
			byteEnd: end,
			text: new TextDecoder("utf-8", { fatal: true }).decode(segmentBytesSlice),
			sha256: sha256Hex(segmentBytesSlice),
		});
		start = end;
		index += 1;
	}

	if (start !== totalBytes) {
		throw new MemorySegmentationError(
			"Segmentation did not cover the source exactly",
			"MEMORY_SEGMENT_COVERAGE_FAILURE",
			{ start, totalBytes },
		);
	}

	return {
		segments,
		descriptor: {
			v: 1,
			field,
			encoding: "utf-8",
			segmentBytes,
			totalBytes,
			totalSha256,
			segmentCount: segments.length,
			generation,
			revision: buildSegmentationRevision(generation, totalSha256),
		},
	};
}

/** Opaque public revision for one immutable generation. */
export function buildSegmentationRevision(
	generation: string,
	totalSha256: string,
): string {
	return `seg:${generation}:${totalSha256}`;
}

/**
 * Bounded inline replacement stored in a segmented field once the source
 * bytes live in the segment store (#25140). Machine-prefixed and
 * digest-bearing so no legitimate content can collide with it; consumers
 * that predate paged reads see an explicit marker, never silent truncation.
 */
export function buildSegmentedContentMarker(descriptor: {
	revision: string;
	totalBytes: number;
	totalSha256: string;
}): string {
	return `[elizaos:segmented-content revision=${descriptor.revision} total-bytes=${descriptor.totalBytes} source-sha256=${descriptor.totalSha256}]`;
}

/** True when `text` is a segmented-content published marker. */
export function isSegmentedContentMarker(text: string): boolean {
	return text.startsWith("[elizaos:segmented-content ");
}

/**
 * Parses a published segmented-content marker into its descriptor fields.
 * Returns null for any text that is not an exactly-formed marker (the marker
 * is machine-written by `buildSegmentedContentMarker`, so anything the regex
 * does not match is user data that merely resembles the prefix, never a
 * descriptor). #25140 review R4: consumers must not treat a marker prefix as
 * proof of a well-formed descriptor.
 */
export function parseSegmentedContentMarker(
	text: string,
): { revision: string; totalBytes: number; totalSha256: string } | null {
	const match = text.match(
		/^\[elizaos:segmented-content revision=([^ ]+) total-bytes=(\d+) source-sha256=([0-9a-f]{64})\]$/,
	);
	if (!match) return null;
	const totalBytes = Number(match[2]);
	if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
	return {
		revision: match[1],
		totalBytes,
		totalSha256: match[3],
	};
}

/**
 * True when a runtime surface exposes the #25140 native content-paging
 * capability: BOTH the `memoryContentPageCapability` advertisement and the
 * `getMemoryContentPage` method. Method presence alone is not a capability
 * claim — a runtime that forwards adapter members but sits on an adapter
 * without the segment store would otherwise receive page calls it cannot
 * honor, and a capability advertisement without the method is a broken
 * adapter. Actions gate paged reads on this predicate, falling back to the
 * ordinary inline path otherwise.
 */
export function hasMemoryContentPageCapability(surface: {
	getMemoryContentPage?: unknown;
	memoryContentPageCapability?: unknown;
}): boolean {
	return (
		surface.memoryContentPageCapability === 1 &&
		typeof surface.getMemoryContentPage === "function"
	);
}

/** Clamps a requested page window to the hard page ceiling and UTF-8 boundaries. */
export function clampPageWindow(
	totalBytes: number,
	byteStart: number,
	byteLimit: number | undefined,
): { start: number; end: number } {
	if (!Number.isInteger(byteStart) || byteStart < 0) {
		throw new MemorySegmentationError(
			"Page byte offset must be a nonnegative integer",
			"MEMORY_PAGE_INVALID_OFFSET",
			{ byteStart },
		);
	}
	if (byteStart > totalBytes) {
		throw new MemorySegmentationError(
			"Page byte offset exceeds the source",
			"MEMORY_PAGE_INVALID_OFFSET",
			{ byteStart, totalBytes },
		);
	}
	let limit = byteLimit ?? MEMORY_PAGE_MAX_BYTES;
	if (!Number.isInteger(limit) || limit <= 0) {
		throw new MemorySegmentationError(
			"Page byte limit must be a positive integer",
			"MEMORY_PAGE_INVALID_LIMIT",
			{ byteLimit },
		);
	}
	limit = Math.min(limit, MEMORY_PAGE_MAX_BYTES);
	return { start: byteStart, end: Math.min(byteStart + limit, totalBytes) };
}

/** Reassembles segment texts and verifies descriptor invariants (test/migration path). */
export function reassembleAndVerify(
	segments: Array<{
		byteStart: number;
		byteEnd: number;
		text: string;
		sha256: string;
	}>,
	descriptor: MemoryContentSegmentation,
): string {
	if (segments.length !== descriptor.segmentCount) {
		throw new MemorySegmentationError(
			"Segment count does not match the descriptor",
			"MEMORY_SEGMENT_COUNT_MISMATCH",
			{ expected: descriptor.segmentCount, actual: segments.length },
		);
	}
	const parts: string[] = [];
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		if (segment.byteStart >= segment.byteEnd) {
			throw new MemorySegmentationError(
				"Segment range is empty or inverted",
				"MEMORY_SEGMENT_RANGE_INVALID",
				{ index: i },
			);
		}
		const expectedStart = i === 0 ? 0 : segments[i - 1].byteEnd;
		if (segment.byteStart !== expectedStart) {
			throw new MemorySegmentationError(
				"Segments overlap or leave a gap",
				"MEMORY_SEGMENT_NOT_CONTIGUOUS",
				{ index: i, expectedStart, actualStart: segment.byteStart },
			);
		}
		const bytes = encodeUtf8Strict(segment.text);
		if (bytes.length !== segment.byteEnd - segment.byteStart) {
			throw new MemorySegmentationError(
				"Segment text byte length does not match its range",
				"MEMORY_SEGMENT_LENGTH_MISMATCH",
				{ index: i },
			);
		}
		if (sha256Hex(bytes) !== segment.sha256) {
			throw new MemorySegmentationError(
				"Segment digest does not match its bytes",
				"MEMORY_SEGMENT_DIGEST_MISMATCH",
				{ index: i },
			);
		}
		parts.push(segment.text);
	}
	const whole = parts.join("");
	const bytes = encodeUtf8Strict(whole);
	if (bytes.length !== descriptor.totalBytes) {
		throw new MemorySegmentationError(
			"Reassembled byte length does not match the descriptor",
			"MEMORY_SEGMENT_TOTAL_MISMATCH",
			{ expected: descriptor.totalBytes, actual: bytes.length },
		);
	}
	if (sha256Hex(bytes) !== descriptor.totalSha256) {
		throw new MemorySegmentationError(
			"Reassembled digest does not match the descriptor",
			"MEMORY_SEGMENT_TOTAL_DIGEST_MISMATCH",
			{},
		);
	}
	return whole;
}
