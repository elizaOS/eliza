/**
 * Coverage for callback codec.
 * Consolidated from colocated and __tests__/callback suites.
 * Preserves all unique assertions including precise byte-length boundaries
 * and unicode handling from __tests__.
 */
import { describe, expect, it } from "vitest";

import {
	decodeCallback,
	encodeReplyCallback,
	isInteractionCallback,
	MAX_CALLBACK_BYTES,
} from "./callback.js";

describe("encodeReplyCallback", () => {
	it("encodes within limit", () => {
		const out = encodeReplyCallback("yes");
		expect(out).toBe("ia1:yes");
	});

	it("returns null when exceeds limit", () => {
		const long = "a".repeat(100);
		expect(encodeReplyCallback(long, { maxBytes: 10 })).toBeNull();
	});

	it("respects custom maxBytes", () => {
		expect(encodeReplyCallback("hi", { maxBytes: 10 })).toBe("ia1:hi");
		expect(encodeReplyCallback("hi", { maxBytes: 4 })).toBeNull();
	});

	it("handles empty value", () => {
		expect(encodeReplyCallback("")).toBe("ia1:");
	});

	it("handles unicode byte length", () => {
		const emoji = "\u{1F600}";
		const out = encodeReplyCallback(emoji, { maxBytes: 64 });
		expect(typeof out).toBe("string");
	});

	// Merged from __tests__: precise byte-boundary assertions
	it("encodes within the default 64-byte limit (merged)", () => {
		expect(encodeReplyCallback("yes")).toBe("ia1:yes");
		expect(encodeReplyCallback("a".repeat(60))).not.toBeNull();
	});

	it("returns null when the payload exceeds the limit (merged precise)", () => {
		expect(encodeReplyCallback("a".repeat(61))).toBeNull();
	});

	it("respects a custom maxBytes (merged precise)", () => {
		expect(encodeReplyCallback("hi", { maxBytes: 5 })).toBeNull();
		expect(encodeReplyCallback("hi", { maxBytes: 100 })).toBe("ia1:hi");
	});

	it("measures bytes not characters for unicode (merged precise)", () => {
		// 💖 is 4 bytes; 15 emoji + prefix ("ia1:") = exactly 64, 16 exceeds.
		expect(encodeReplyCallback("💖".repeat(16))).toBeNull();
		expect(encodeReplyCallback("💖".repeat(15))).not.toBeNull();
	});
});

describe("isInteractionCallback", () => {
	it("true for encoded payload", () => {
		expect(isInteractionCallback("ia1:yes")).toBe(true);
	});

	it("false for other strings", () => {
		expect(isInteractionCallback("other:yes")).toBe(false);
		expect(isInteractionCallback("")).toBe(false);
	});

	it("false for non-strings", () => {
		expect(isInteractionCallback(null)).toBe(false);
		expect(isInteractionCallback(42 as unknown as string)).toBe(false);
	});

	// Merged precise variant
	it("recognizes encoded callbacks (merged)", () => {
		expect(isInteractionCallback("ia1:x")).toBe(true);
		expect(isInteractionCallback("other")).toBe(false);
		expect(isInteractionCallback(5 as unknown as string)).toBe(false);
	});
});

describe("decodeCallback", () => {
	it("decodes valid callback", () => {
		const encoded = encodeReplyCallback("hello") as string;
		const decoded = decodeCallback(encoded);
		expect(decoded?.value).toBe("hello");
		expect(decoded?.kind).toBe("reply");
	});

	it("returns null for invalid", () => {
		expect(decodeCallback("bad")).toBeNull();
		expect(decodeCallback(null as unknown as string)).toBeNull();
	});

	// Merged precise variant
	it("decodes reply callbacks (merged precise)", () => {
		expect(decodeCallback("ia1:hello")).toEqual({
			kind: "reply",
			value: "hello",
		});
	});

	it("returns null for foreign payloads (merged)", () => {
		expect(decodeCallback("other")).toBeNull();
		expect(decodeCallback(null as unknown as string)).toBeNull();
	});
});

describe("MAX_CALLBACK_BYTES", () => {
	it("is 64", () => {
		expect(MAX_CALLBACK_BYTES).toBe(64);
	});
});
