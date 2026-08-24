/**
 * Tests for fact-write-dedupe — normalizeFactTextKey and mergeStrongerFactMetadata.
 */
import { describe, expect, it, vi } from "vitest";
import {
	findEquivalentFact,
	mergeStrongerFactMetadata,
	normalizeFactTextKey,
} from "./fact-write-dedupe.ts";

describe("fact-write-dedupe", () => {
	it("normalizes text case and punctuation", () => {
		expect(normalizeFactTextKey("Hello, World!")).toBe("hello world");
		expect(normalizeFactTextKey("  HELLO   world  ")).toBe("hello world");
	});

	it("handles unicode letters", () => {
		expect(normalizeFactTextKey("caf\u00e9")).toBe("caf\u00e9");
	});

	it("returns empty for punctuation-only", () => {
		expect(normalizeFactTextKey("!!!")).toBe("");
		expect(normalizeFactTextKey("")).toBe("");
	});

	it("mergeStrongerFactMetadata upgrades confidence", () => {
		const existing = { metadata: { confidence: 0.5 } } as never;
		const incoming = { metadata: { confidence: 0.9 } } as never;
		const merged = mergeStrongerFactMetadata(existing, incoming);
		expect(merged?.confidence).toBe(0.9);
	});

	it("mergeStrongerFactMetadata returns null when no upgrade", () => {
		const existing = { metadata: { confidence: 0.9 } } as never;
		const incoming = { metadata: { confidence: 0.5 } } as never;
		expect(mergeStrongerFactMetadata(existing, incoming)).toBeNull();
	});

	it("mergeStrongerFactMetadata upgrades kind when missing", () => {
		const existing = { metadata: {} } as never;
		const incoming = { metadata: { kind: "current" } } as never;
		expect(mergeStrongerFactMetadata(existing, incoming)?.kind).toBe("current");
	});

	it("mergeStrongerFactMetadata upgrades validAt when newer", () => {
		const existing = {
			metadata: { validAt: "2024-01-01T00:00:00.000Z" },
		} as never;
		const incoming = {
			metadata: { validAt: "2024-06-01T00:00:00.000Z" },
		} as never;
		expect(mergeStrongerFactMetadata(existing, incoming)?.validAt).toBe(
			"2024-06-01T00:00:00.000Z",
		);
	});

	it("findEquivalentFact returns matching candidate", async () => {
		const runtime = {
			getMemories: vi.fn(async () => [
				{
					id: "c1",
					entityId: "e1",
					roomId: "r1",
					content: { text: "Hello world" },
				},
			]),
		} as never;
		const memory = {
			id: "new",
			entityId: "e1",
			roomId: "r1",
			content: { text: "hello, WORLD!" },
		} as never;
		const found = await findEquivalentFact(runtime, memory);
		expect(found?.id).toBe("c1");
	});

	it("findEquivalentFact returns null when no match", async () => {
		const runtime = {
			getMemories: vi.fn(async () => []),
		} as never;
		const memory = {
			id: "new",
			entityId: "e1",
			roomId: "r1",
			content: { text: "different text" },
		} as never;
		expect(await findEquivalentFact(runtime, memory)).toBeNull();
	});
});
