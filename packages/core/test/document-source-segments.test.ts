/**
 * Regression coverage for #38719: a UTF-8 byte order mark at a segment start
 * must survive decoding. TextDecoder drops a leading BOM by default, so the
 * decoded segment is 3 bytes shorter than its recorded byte range and the
 * readback rejects it as DOCUMENT_SOURCE_CORRUPT.
 */
import { randomUUID } from "node:crypto";
import type { UUID } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	buildDocumentSourceProjection,
	DOCUMENT_SOURCE_SEGMENT_MAX_BYTES,
	readDocumentSourceProjection,
	requireDocumentSourceReadMetadata,
	type DocumentSourceProjection,
} from "../src/database/document-source-segments.ts";

const encoder = new TextEncoder();

function buildProjection(text: string) {
	const documentId = randomUUID() as UUID;
	const agentId = randomUUID() as UUID;
	const documentMetadata = {
		type: "document",
		source: "upload",
		scope: "global",
		documentRevision: 0,
		timestamp: Date.now(),
	};
	const projection = buildDocumentSourceProjection({
		text,
		documentId,
		agentId,
		roomId: agentId,
		entityId: agentId,
		documentMetadata: documentMetadata as never,
	});
	const parent = requireDocumentSourceReadMetadata(
		{ ...documentMetadata, ...projection.metadata },
		documentId,
	);
	return { documentId, projection, parent };
}

function assertSegmentByteLengthIdentity(
	projection: DocumentSourceProjection,
) {
	for (const segment of projection.segments) {
		const metadata = segment.metadata as Record<string, unknown>;
		const start = metadata.sourceByteStart as number;
		const end = metadata.sourceByteEnd as number;
		expect(encoder.encode(segment.content.text ?? "").byteLength).toBe(
			end - start,
		);
	}
}

describe("document source segments with a byte order mark", () => {
	it("keeps a leading byte order mark on build and byte readback", () => {
		const text = "\uFEFFhello world\n";
		const { documentId, projection, parent } = buildProjection(text);
		expect(projection.segments).toHaveLength(1);
		expect(projection.segments[0]?.content.text?.charCodeAt(0)).toBe(0xfeff);
		assertSegmentByteLengthIdentity(projection);
		const read = readDocumentSourceProjection({
			segments: projection.segments,
			params: {
				unit: "byte",
				offset: 0,
				limit: projection.metadata.sourceByteLength,
			},
			parent,
			documentId,
			sourceQueryCount: 1,
		});
		expect(read.text).toBe(text);
	});

	it("keeps a byte order mark that starts the second segment", () => {
		const text =
			"a".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES) + "\uFEFFhello world\n";
		const { documentId, projection, parent } = buildProjection(text);
		expect(projection.segments).toHaveLength(2);
		expect(projection.segments[1]?.content.text?.charCodeAt(0)).toBe(0xfeff);
		assertSegmentByteLengthIdentity(projection);
		const boundary = DOCUMENT_SOURCE_SEGMENT_MAX_BYTES;
		const page = readDocumentSourceProjection({
			segments: projection.segments,
			params: {
				unit: "byte",
				offset: boundary,
				limit: projection.metadata.sourceByteLength - boundary,
			},
			parent,
			documentId,
			sourceQueryCount: 1,
		});
		expect(page.text).toBe("\uFEFFhello world\n");
		const full = readDocumentSourceProjection({
			segments: projection.segments,
			params: {
				unit: "byte",
				offset: 0,
				limit: projection.metadata.sourceByteLength,
			},
			parent,
			documentId,
			sourceQueryCount: 1,
		});
		expect(full.text).toBe(text);
	});
});
