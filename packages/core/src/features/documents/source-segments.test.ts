/**
 * Proves the canonical document source projection with deterministic in-memory
 * adapter storage. The suite exercises exact UTF-8 reassembly, giant logical
 * unit continuation, bounded source-work counters, authorization, legacy
 * migration failure, and corruption-sensitive invariants.
 */
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import type { DocumentRangeReadParams, Memory, UUID } from "../../types";
import { MemoryType } from "../../types";
import {
	buildDocumentSourceProjection,
	DOCUMENT_SOURCE_READ_LOOKAHEAD_SEGMENTS,
	DOCUMENT_SOURCE_SEGMENT_MAX_BYTES,
	readDocumentSourceProjection,
	requireDocumentSourceReadMetadata,
} from "./source-segments";
import type { DocumentMemoryMetadata } from "./types";

const AGENT_ID = "d1000000-0000-4000-8000-000000000001" as UUID;
const USER_ID = "d1000000-0000-4000-8000-000000000002" as UUID;
const OTHER_ID = "d1000000-0000-4000-8000-000000000003" as UUID;
const ROOM_ID = "d1000000-0000-4000-8000-000000000004" as UUID;
const WORLD_ID = "d1000000-0000-4000-8000-000000000005" as UUID;
const DOCUMENT_ID = "d1000000-0000-4000-8000-000000000006" as UUID;
const ATTEMPT_ID = "d1000000-0000-4000-8000-000000000007" as UUID;

function parentDocument(text: string, documentId = DOCUMENT_ID): Memory {
	return {
		id: documentId,
		agentId: AGENT_ID,
		entityId: USER_ID,
		roomId: ROOM_ID,
		worldId: WORLD_ID,
		content: { text },
		metadata: {
			type: MemoryType.DOCUMENT,
			documentId,
			documentRevision: 3,
			revisionAttemptId: ATTEMPT_ID,
			scope: "global",
			timestamp: 1_000,
		},
	};
}

function projection(text: string, documentId = DOCUMENT_ID) {
	const parent = parentDocument(text, documentId);
	const source = buildDocumentSourceProjection({
		text,
		documentId,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		entityId: USER_ID,
		worldId: WORLD_ID,
		documentMetadata: parent.metadata as DocumentMemoryMetadata,
	});
	return {
		parent: {
			...parent,
			metadata: { ...parent.metadata, ...source.metadata },
		} as Memory,
		segments: source.segments,
	};
}

function intersectingSegments(
	segments: Memory[],
	params: Pick<DocumentRangeReadParams, "unit" | "offset" | "limit">,
	total: number,
): Memory[] {
	const coordinate =
		params.unit === "byte"
			? "Byte"
			: params.unit === "line"
				? "Line"
				: "Fragment";
	const startKey = `source${coordinate}Start`;
	const endKey = `source${coordinate}End`;
	const end = Math.min(params.offset + params.limit, total);
	return segments
		.filter((segment) => {
			const metadata = segment.metadata as unknown as Record<string, unknown>;
			return (
				Number(metadata[endKey]) > params.offset &&
				Number(metadata[startKey]) < end
			);
		})
		.slice(0, DOCUMENT_SOURCE_READ_LOOKAHEAD_SEGMENTS);
}

function readProjection(
	projected: ReturnType<typeof projection>,
	params: Pick<DocumentRangeReadParams, "unit" | "offset" | "limit">,
) {
	const metadata = requireDocumentSourceReadMetadata(
		projected.parent.metadata as unknown as Record<string, unknown>,
		projected.parent.id as UUID,
	);
	const total =
		params.unit === "byte"
			? metadata.sourceByteLength
			: params.unit === "line"
				? metadata.sourceLineCount
				: metadata.sourceFragmentCount;
	return readDocumentSourceProjection({
		segments: intersectingSegments(projected.segments, params, total),
		params,
		parent: metadata,
		documentId: projected.parent.id as UUID,
		sourceQueryCount: 2,
	});
}

describe("canonical document source segments", () => {
	it("stores non-overlapping UTF-8 ranges and reconstructs mixed newline pages exactly", () => {
		const source = `${"a".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES - 2)}😀\r\nβeta\n\ngamma`;
		const projected = projection(source);
		expect(projected.segments.length).toBeGreaterThan(1);
		let nextByte = 0;
		for (const [position, segment] of projected.segments.entries()) {
			const metadata = segment.metadata as unknown as Record<string, unknown>;
			expect(metadata.position).toBe(position);
			expect(metadata.sourceByteStart).toBe(nextByte);
			nextByte = Number(metadata.sourceByteEnd);
			expect(Buffer.byteLength(segment.content.text ?? "", "utf8")).toBe(
				nextByte - Number(metadata.sourceByteStart),
			);
			expect(segment.content.text).not.toContain("�");
		}
		expect(nextByte).toBe(Buffer.byteLength(source, "utf8"));

		const fragmentTexts: string[] = [];
		let offset = 0;
		for (;;) {
			const page = readProjection(projected, {
				unit: "fragment",
				offset,
				limit: 1,
			});
			fragmentTexts.push(page.text);
			if (page.end === page.total) break;
			offset = page.end;
		}
		expect(fragmentTexts.join("")).toBe(source);
	});

	it("converts a giant line to bounded byte continuation without loss or no-progress pages", () => {
		const source = `${"x".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES * 6)}😀\nlast\n`;
		const projected = projection(source);
		const first = readProjection(projected, {
			unit: "line",
			offset: 0,
			limit: 1,
		});
		expect(first).toMatchObject({
			unit: "byte",
			start: 0,
			sourceQueryCount: 2,
			examinedSourceSegments: DOCUMENT_SOURCE_READ_LOOKAHEAD_SEGMENTS,
		});
		expect(first.end).toBeGreaterThan(first.start);
		expect(first.sourceBytesRead).toBeLessThanOrEqual(
			DOCUMENT_SOURCE_READ_LOOKAHEAD_SEGMENTS *
				DOCUMENT_SOURCE_SEGMENT_MAX_BYTES,
		);

		const pages = [first.text];
		let offset = first.end;
		while (offset < first.total) {
			const page = readProjection(projected, {
				unit: "byte",
				offset,
				limit: 100,
			});
			expect(page.end).toBeGreaterThan(offset);
			expect(page.returnedSourceSegments).toBeLessThanOrEqual(2);
			pages.push(page.text);
			offset = page.end;
		}
		expect(pages.join("")).toBe(source);
	});

	it("rejects byte ranges that split a multibyte code point", () => {
		const projected = projection("😀tail");
		expect(() =>
			readProjection(projected, { unit: "byte", offset: 1, limit: 4 }),
		).toThrowError(
			expect.objectContaining({ code: "DOCUMENT_READ_INVALID_UTF8_BOUNDARY" }),
		);
		expect(() =>
			readProjection(projected, { unit: "byte", offset: 0, limit: 1 }),
		).toThrowError(
			expect.objectContaining({ code: "DOCUMENT_READ_INVALID_UTF8_BOUNDARY" }),
		);
	});

	it("kills coordinate and same-length payload mutations", () => {
		const projected = projection(
			"z".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES * 2 + 8),
		);
		const params = {
			unit: "byte" as const,
			offset: DOCUMENT_SOURCE_SEGMENT_MAX_BYTES - 1,
			limit: 10,
		};
		const metadata = requireDocumentSourceReadMetadata(
			projected.parent.metadata as unknown as Record<string, unknown>,
			DOCUMENT_ID,
		);
		const rows = intersectingSegments(
			projected.segments,
			params,
			metadata.sourceByteLength,
		);
		const corrupted = rows.map((row) => ({
			...row,
			metadata: { ...row.metadata },
		}));
		(
			corrupted[1].metadata as unknown as Record<string, unknown>
		).sourceByteStart =
			Number(
				(corrupted[1].metadata as unknown as Record<string, unknown>)
					.sourceByteStart,
			) + 1;
		expect(() =>
			readDocumentSourceProjection({
				segments: corrupted,
				params,
				parent: metadata,
				documentId: DOCUMENT_ID,
				sourceQueryCount: 2,
			}),
		).toThrowError(
			expect.objectContaining({ code: "DOCUMENT_SOURCE_CORRUPT" }),
		);
		const payloadMutated = rows.map((row) => ({
			...row,
			content: { ...row.content },
		}));
		payloadMutated[0].content.text = `q${payloadMutated[0].content.text?.slice(1)}`;
		expect(() =>
			readDocumentSourceProjection({
				segments: payloadMutated,
				params,
				parent: metadata,
				documentId: DOCUMENT_ID,
				sourceQueryCount: 2,
			}),
		).toThrowError(
			expect.objectContaining({ code: "DOCUMENT_SOURCE_CORRUPT" }),
		);
	});

	it("rejects a surviving giant-line prefix instead of fabricating completeness", () => {
		const projected = projection(
			`${"g".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES * 6)}\n`,
		);
		const metadata = requireDocumentSourceReadMetadata(
			projected.parent.metadata as unknown as Record<string, unknown>,
			DOCUMENT_ID,
		);
		expect(() =>
			readDocumentSourceProjection({
				segments: projected.segments.slice(0, 3),
				params: { unit: "line", offset: 0, limit: 1 },
				parent: metadata,
				documentId: DOCUMENT_ID,
				sourceQueryCount: 2,
			}),
		).toThrowError(
			expect.objectContaining({ code: "DOCUMENT_SOURCE_CORRUPT" }),
		);
	});

	it("rejects a giant-line continuation when its leading segment is missing", () => {
		const projected = projection(
			`${"g".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES * 6)}\n`,
		);
		const metadata = requireDocumentSourceReadMetadata(
			projected.parent.metadata as unknown as Record<string, unknown>,
			DOCUMENT_ID,
		);
		expect(() =>
			readDocumentSourceProjection({
				segments: projected.segments.slice(1, 6),
				params: { unit: "line", offset: 0, limit: 1 },
				parent: metadata,
				documentId: DOCUMENT_ID,
				sourceQueryCount: 2,
			}),
		).toThrowError(
			expect.objectContaining({ code: "DOCUMENT_SOURCE_CORRUPT" }),
		);
	});
});

describe("in-memory document source adapter", () => {
	it("reads bounded late pages, reauthorizes, and rejects authorized legacy parents", async () => {
		const adapter = new InMemoryDatabaseAdapter();
		const source = Array.from(
			{ length: 4_000 },
			(_, index) => `line-${index}😀\n`,
		).join("");
		const projected = projection(source);
		await adapter.createMemories([
			{ memory: projected.parent, tableName: "documents" },
			...projected.segments.map((memory) => ({
				memory,
				tableName: "document_fragments",
			})),
		]);
		const page = await adapter.readDocumentRange({
			agentId: AGENT_ID,
			documentId: DOCUMENT_ID,
			requesterEntityId: USER_ID,
			requesterRoomIds: [ROOM_ID],
			requesterRole: "USER",
			unit: "line",
			offset: 3_999,
			limit: 1,
		});
		expect(page).toMatchObject({
			text: "line-3999😀\n",
			total: 4_000,
			sourceQueryCount: 2,
		});
		expect(page?.examinedSourceSegments).toBeLessThanOrEqual(
			DOCUMENT_SOURCE_READ_LOOKAHEAD_SEGMENTS,
		);
		await expect(
			adapter.readDocumentRange({
				agentId: AGENT_ID,
				documentId: DOCUMENT_ID,
				requesterEntityId: OTHER_ID,
				requesterRoomIds: [],
				requesterRole: "GUEST",
				unit: "line",
				offset: 0,
				limit: 1,
			}),
		).resolves.toBeNull();

		const legacyId = "d1000000-0000-4000-8000-000000000008" as UUID;
		await adapter.createMemories([
			{
				memory: parentDocument("legacy body", legacyId),
				tableName: "documents",
			},
		]);
		await expect(
			adapter.readDocumentRange({
				agentId: AGENT_ID,
				documentId: legacyId,
				requesterEntityId: USER_ID,
				requesterRoomIds: [ROOM_ID],
				requesterRole: "USER",
				unit: "line",
				offset: 0,
				limit: 1,
			}),
		).rejects.toMatchObject({ code: "DOCUMENT_REINDEX_REQUIRED" });
	});
});
