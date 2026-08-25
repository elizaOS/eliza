/**
 * Coverage for callback codec.
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
});

describe("MAX_CALLBACK_BYTES", () => {
	it("is 64", () => {
		expect(MAX_CALLBACK_BYTES).toBe(64);
	});
});
