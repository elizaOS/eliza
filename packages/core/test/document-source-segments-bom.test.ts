/** A UTF-8 BOM is source bytes: segments and byte pages must preserve it. */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
	buildDocumentSourceProjection,
	DOCUMENT_SOURCE_SEGMENT_MAX_BYTES,
	readDocumentSourceProjection,
	requireDocumentSourceReadMetadata,
	type UUID,
} from "../src/database/document-source-segments.ts";

function projection(text: string) {
	const documentId = randomUUID() as UUID;
	const agentId = randomUUID() as UUID;
	const documentMetadata = {
		type: "document",
		source: "upload",
		scope: "global",
		documentRevision: 0,
		timestamp: Date.now(),
	};
	const built = buildDocumentSourceProjection({
		text,
		documentId,
		agentId,
		roomId: agentId,
		entityId: agentId,
		documentMetadata: documentMetadata as never,
	});
	const parent = requireDocumentSourceReadMetadata(
		{ ...documentMetadata, ...built.metadata },
		documentId,
	);
	return {
		documentId,
		text,
		segments: built.segments,
		parent,
		metadata: built.metadata,
	};
}

function fullByteRead(text: string) {
	const fixture = projection(text);
	return readDocumentSourceProjection({
		segments: fixture.segments,
		params: { unit: "byte", offset: 0, limit: 2_000_000 },
		parent: fixture.parent,
		documentId: fixture.documentId,
		sourceQueryCount: 1,
	});
}

it("reads back a segments-stored document that starts with a BOM", () => {
	const text = `\uFEFF${"a".repeat(70_000)}`;
	const read = fullByteRead(text);
	expect(read.text).toBe(text);
	// The BOM is one UTF-16 code unit but three source bytes.
	expect(read.returnedSourceBytes).toBe(new TextEncoder().encode(text).length);
});

it("reads back a document whose BOM sits on a segment boundary", () => {
	const text = `${"a".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES)}\uFEFF${"b".repeat(100)}`;
	const read = fullByteRead(text);
	expect(read.text).toBe(text);
});

it("returns the BOM on a byte page that starts on it", () => {
	const text = `${"a".repeat(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES)}\uFEFF${"b".repeat(100)}`;
	const fixture = projection(text);
	const read = readDocumentSourceProjection({
		segments: fixture.segments,
		params: {
			unit: "byte",
			offset: DOCUMENT_SOURCE_SEGMENT_MAX_BYTES,
			limit: 64,
		},
		parent: fixture.parent,
		documentId: fixture.documentId,
		sourceQueryCount: 1,
	});
	expect(read.text.startsWith("\uFEFF")).toBe(true);
	expect(read.returnedSourceBytes).toBe(64);
	expect(read.end).toBe(DOCUMENT_SOURCE_SEGMENT_MAX_BYTES + 64);
});

it("keeps the no-BOM path unchanged", () => {
	const text = "a".repeat(70_000);
	expect(fullByteRead(text).text).toBe(text);
});
