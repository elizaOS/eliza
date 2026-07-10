/**
 * Pins the agent-facing render of a transcript-anchored search hit (#14806):
 * the DOCUMENT search handler prefixes a hit that carries `startMs`/`endMs`
 * with a `[m:ss–m:ss]` clock so the model can cite where in the recording the
 * match sits, and renders a bare line for an unanchored hit. Deterministic: the
 * real `handleSearch` runs against a DocumentService stub whose
 * `searchDocuments` returns fixed rows; no live model, no database.
 */
import { describe, expect, it, vi } from "vitest";
import type { Content, Memory, UUID } from "../../../types";
import { handleSearch } from "../actions";
import type { DocumentService } from "../service";
import type { StoredDocument } from "../types";

const DOC_ID = "11111111-2222-4333-8444-555555555555" as UUID;

function row(
	text: string,
	metadata: Record<string, unknown> | undefined,
	similarity: number,
): StoredDocument {
	return {
		id: DOC_ID,
		content: { text } as Content,
		metadata,
		similarity,
	};
}

function stubService(rows: StoredDocument[]): DocumentService {
	return {
		searchDocuments: vi.fn(async () => rows),
	} as unknown as DocumentService;
}

const message = {
	id: DOC_ID,
	entityId: DOC_ID,
	agentId: DOC_ID,
	roomId: DOC_ID,
	content: { text: "hello" },
	createdAt: Date.now(),
} as unknown as Memory;

async function renderedText(rows: StoredDocument[]): Promise<string> {
	let captured = "";
	await handleSearch(
		stubService(rows),
		message,
		{ query: "hello" } as never,
		async (content) => {
			captured = content.text ?? "";
			return [];
		},
	);
	return captured;
}

describe("DOCUMENT search render — transcript anchor prefix", () => {
	it("prefixes an anchored hit with an [m:ss–m:ss] clock", async () => {
		const text = await renderedText([
			row("Alice: hello there", { startMs: 61000, endMs: 62500 }, 0.9),
		]);
		expect(text).toContain("1. [1:01–1:02] Alice: hello there");
	});

	it("renders an unanchored hit bare (no clock prefix)", async () => {
		const text = await renderedText([
			row("plain document text", undefined, 0.9),
		]);
		expect(text).toContain("1. plain document text");
		expect(text).not.toContain("[");
	});

	it("renders start-only when endMs is absent", async () => {
		const text = await renderedText([row("Bob: hi", { startMs: 5000 }, 0.9)]);
		expect(text).toContain("1. [0:05] Bob: hi");
	});

	it("uses an h:mm:ss clock past one hour", async () => {
		const text = await renderedText([
			row("late remark", { startMs: 3661000, endMs: 3662000 }, 0.9),
		]);
		expect(text).toContain("1. [1:01:01–1:01:02] late remark");
	});

	it("drops a malformed anchor (negative start / inverted end)", async () => {
		const negative = await renderedText([
			row("neg", { startMs: -500, endMs: 1000 }, 0.9),
		]);
		expect(negative).toContain("1. neg");
		expect(negative).not.toContain("[");

		const inverted = await renderedText([
			row("inv", { startMs: 2000, endMs: 100 }, 0.9),
		]);
		// Inverted end is dropped; the valid start still renders.
		expect(inverted).toContain("1. [0:02] inv");
		expect(inverted).not.toContain("0:00");
	});

	it("reports no matches for an empty result set", async () => {
		const text = await renderedText([]);
		expect(text).toContain(`couldn't find any documents matching "hello"`);
	});
});
