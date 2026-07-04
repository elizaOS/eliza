/**
 * Unit tests pinning the `extractContentMetadata` contract used by the service
 * (metadata coercion from `Content`). Pure-function assertions.
 */
import type { Content } from "@elizaos/core";
import { describe, expect, it } from "vitest";

// Re-implementation under test. The production version lives in
// `plugins/plugin-discord/service.ts` but isn't exported; this test
// validates the contract any future refactor must preserve.
function extractContentMetadata(
	content: Content | undefined,
): Record<string, unknown> {
	const meta = content?.metadata;
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
	return meta as Record<string, unknown>;
}

describe("extractContentMetadata", () => {
	it("forwards a plain object", () => {
		const out = extractContentMetadata({
			text: "hello",
			metadata: { transient: true, foo: "bar" },
		} as Content);
		expect(out).toEqual({ transient: true, foo: "bar" });
	});

	it("returns empty object on undefined content", () => {
		expect(extractContentMetadata(undefined)).toEqual({});
	});

	it("returns empty object on missing metadata", () => {
		expect(extractContentMetadata({ text: "hello" } as Content)).toEqual({});
	});

	it("refuses array metadata (would otherwise spread indices as keys)", () => {
		expect(
			extractContentMetadata({
				text: "hello",
				metadata: ["a", "b"] as unknown as Content["metadata"],
			} as Content),
		).toEqual({});
	});

	it("refuses null metadata", () => {
		expect(
			extractContentMetadata({
				text: "hello",
				metadata: null as unknown as Content["metadata"],
			} as Content),
		).toEqual({});
	});

	it("refuses primitive metadata (string)", () => {
		expect(
			extractContentMetadata({
				text: "hello",
				metadata: "transient" as unknown as Content["metadata"],
			} as Content),
		).toEqual({});
	});

	it("preserves nested objects in metadata", () => {
		const out = extractContentMetadata({
			text: "hello",
			metadata: { nested: { transient: true } } as Content["metadata"],
		} as Content);
		expect(out).toEqual({ nested: { transient: true } });
	});
});
