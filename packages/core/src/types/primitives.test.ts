/**
 * Coverage for the runtime surface of the foundational primitives module:
 * `asUUID` validation and passthrough, the nil `DEFAULT_UUID`, and the
 * `ChannelType` / `ContentType` token maps as they flow through serialized
 * `Media`. Deterministic real-module harness; no mocks.
 */
import { describe, expect, it } from "vitest";
import {
	asUUID,
	ChannelType,
	ContentType,
	DEFAULT_UUID,
} from "./primitives.js";

describe("asUUID", () => {
	it("returns the identical string for a valid UUID", () => {
		const id = "123e4567-e89b-12d3-a456-426614174000";
		expect(asUUID(id)).toBe(id);
	});

	it("accepts uppercase hex and preserves the original casing", () => {
		const id = "123E4567-E89B-12D3-A456-426614174000";
		expect(asUUID(id)).toBe(id);
	});

	it("accepts the nil UUID", () => {
		expect(asUUID(DEFAULT_UUID)).toBe(DEFAULT_UUID);
	});

	it("throws for an empty string", () => {
		expect(() => asUUID("")).toThrow();
	});

	it("throws when a group has the wrong length", () => {
		expect(() => asUUID("123e4567-e89b-12d3-a456-42661417400")).toThrow();
		expect(() => asUUID("123e4567-e89-b12d3-a456-426614174000")).toThrow();
	});

	it("throws when separators are missing entirely", () => {
		expect(() => asUUID("123e4567e89b12d3a456426614174000")).toThrow();
	});

	it("throws when separators are in the wrong positions", () => {
		expect(() => asUUID("123e456-7e89b-12d3-a456-426614174000")).toThrow();
		expect(() => asUUID("123e4567-e89b12d3-a456-426614174000")).toThrow();
	});

	it("throws for non-hex characters", () => {
		expect(() => asUUID("123e4567-e89b-12d3-a456-42661417400g")).toThrow();
	});

	it("includes the offending value in the error message", () => {
		expect(() => asUUID("not-a-uuid")).toThrow(
			"Invalid UUID format: not-a-uuid",
		);
	});

	it("throws for null or undefined input", () => {
		expect(() => asUUID(undefined as unknown as string)).toThrow();
		expect(() => asUUID(null as unknown as string)).toThrow();
	});
});

describe("DEFAULT_UUID", () => {
	it("is the canonical zero UUID", () => {
		expect(DEFAULT_UUID).toBe("00000000-0000-0000-0000-000000000000");
	});
});

describe("ChannelType", () => {
	it("assigns a distinct non-empty string to every channel kind", () => {
		const values = Object.values(ChannelType);
		expect(values.length).toBeGreaterThan(0);
		for (const value of values) {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}
		expect(new Set(values).size).toBe(values.length);
	});
});

describe("ContentType", () => {
	it("assigns a distinct non-empty string to every content kind", () => {
		const values = Object.values(ContentType);
		expect(values.length).toBeGreaterThan(0);
		for (const value of values) {
			expect(typeof value).toBe("string");
			expect(value.length).toBeGreaterThan(0);
		}
		expect(new Set(values).size).toBe(values.length);
	});

	it("survives a JSON round trip on a Media attachment", () => {
		const media = {
			id: "11111111-2222-3333-4444-555555555555",
			url: "/api/media/deadbeef.png",
			contentType: ContentType.IMAGE,
		};
		const parsed = JSON.parse(JSON.stringify(media));
		expect(parsed).toEqual(media);
		expect(parsed.contentType).toBe(ContentType.IMAGE);
	});
});
