/**
 * Exercises the {@link Memory} helpers in ./memory — `createMessageMemory`
 * scoping, the per-`MemoryType` metadata/memory guards, and `getMemoryText` —
 * against hand-built records with no live model or database (pure vitest). The
 * guards drive how each record is stored, embedded, and retrieved, so they must
 * discriminate strictly on the `MemoryType` tag (a document fragment must never
 * be mistaken for a top-level document) and `isCustomMetadata` must stay the
 * catch-all for any type outside the four known kinds.
 */

import { describe, expect, it } from "vitest";
import {
	createMessageMemory,
	getMemoryText,
	isCustomMetadata,
	isDescriptionMetadata,
	isDocumentMemory,
	isDocumentMetadata,
	isFragmentMemory,
	isFragmentMetadata,
	isMessageMetadata,
} from "./memory.ts";
import {
	type Memory,
	type MemoryMetadata,
	MemoryType,
	type UUID,
} from "./types";

const id = (s: string) => s as UUID;

describe("createMessageMemory", () => {
	it("stamps MESSAGE metadata and scope by agentId presence", () => {
		const shared = createMessageMemory({
			entityId: id("e1"),
			roomId: id("r1"),
			content: { text: "hi" },
		});
		expect(shared.metadata?.type).toBe(MemoryType.MESSAGE);
		expect((shared.metadata as { scope?: string }).scope).toBe("shared");

		const priv = createMessageMemory({
			entityId: id("e1"),
			agentId: id("a1"),
			roomId: id("r1"),
			content: { text: "hi" },
		});
		expect((priv.metadata as { scope?: string }).scope).toBe("private");
	});
});

describe("metadata type guards discriminate on type", () => {
	const m = (type: MemoryType): MemoryMetadata => ({ type }) as MemoryMetadata;

	it("each guard accepts only its own type", () => {
		expect(isDocumentMetadata(m(MemoryType.DOCUMENT))).toBe(true);
		expect(isDocumentMetadata(m(MemoryType.FRAGMENT))).toBe(false);
		expect(isFragmentMetadata(m(MemoryType.FRAGMENT))).toBe(true);
		expect(isMessageMetadata(m(MemoryType.MESSAGE))).toBe(true);
		expect(isDescriptionMetadata(m(MemoryType.DESCRIPTION))).toBe(true);
	});

	it("isCustomMetadata is the catch-all outside the four known kinds", () => {
		expect(isCustomMetadata(m("something_else" as MemoryType))).toBe(true);
		expect(isCustomMetadata(m(MemoryType.DOCUMENT))).toBe(false);
		expect(isCustomMetadata(m(MemoryType.MESSAGE))).toBe(false);
	});
});

describe("memory-level guards", () => {
	const mem = (type?: MemoryType): Memory =>
		({
			content: { text: "x" },
			...(type ? { metadata: { type } } : {}),
		}) as Memory;

	it("isDocumentMemory / isFragmentMemory require matching metadata", () => {
		expect(isDocumentMemory(mem(MemoryType.DOCUMENT))).toBe(true);
		expect(isDocumentMemory(mem(MemoryType.FRAGMENT))).toBe(false);
		expect(isDocumentMemory(mem())).toBe(false); // no metadata
		expect(isFragmentMemory(mem(MemoryType.FRAGMENT))).toBe(true);
	});
});

describe("getMemoryText", () => {
	it("returns the text or the default", () => {
		expect(getMemoryText({ content: { text: "hello" } } as Memory)).toBe(
			"hello",
		);
		expect(getMemoryText({ content: {} } as Memory, "fallback")).toBe(
			"fallback",
		);
	});
});
