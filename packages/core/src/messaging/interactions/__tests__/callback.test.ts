import { describe, expect, it } from "vitest";
import {
	decodeCallback,
	encodeReplyCallback,
	isInteractionCallback,
} from "../callback.ts";

describe("encodeReplyCallback", () => {
	it("encodes within the default 64-byte limit", () => {
		expect(encodeReplyCallback("yes")).toBe("ia1:yes");
		expect(encodeReplyCallback("a".repeat(60))).not.toBeNull();
	});

	it("returns null when the payload exceeds the limit", () => {
		expect(encodeReplyCallback("a".repeat(61))).toBeNull();
	});

	it("respects a custom maxBytes", () => {
		expect(encodeReplyCallback("hi", { maxBytes: 5 })).toBeNull();
		expect(encodeReplyCallback("hi", { maxBytes: 100 })).toBe("ia1:hi");
	});

	it("measures bytes not characters for unicode", () => {
		// 💖 is 4 bytes; 15 emoji + prefix ("ia1:") = exactly 64, 16 exceeds.
		expect(encodeReplyCallback("💖".repeat(16))).toBeNull();
		expect(encodeReplyCallback("💖".repeat(15))).not.toBeNull();
	});
});

describe("isInteractionCallback", () => {
	it("recognizes encoded callbacks", () => {
		expect(isInteractionCallback("ia1:x")).toBe(true);
		expect(isInteractionCallback("other")).toBe(false);
		expect(isInteractionCallback(5)).toBe(false);
	});
});

describe("decodeCallback", () => {
	it("decodes reply callbacks", () => {
		expect(decodeCallback("ia1:hello")).toEqual({
			kind: "reply",
			value: "hello",
		});
	});

	it("returns null for foreign payloads", () => {
		expect(decodeCallback("other")).toBeNull();
		expect(decodeCallback(null)).toBeNull();
	});
});
