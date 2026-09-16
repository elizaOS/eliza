/** Exercises callback wire round trips and UTF-8 limits used by connector controls. */
import { describe, expect, it } from "vitest";
import {
	decodeCallback,
	encodeReplyCallback,
	isInteractionCallback,
} from "./callback.js";

describe("interaction callback codec", () => {
	it.each(["yes", "", "💖", "a".repeat(60), "💖".repeat(15)])(
		"round-trips %j within Telegram's 64-byte callback limit",
		(value) => {
			const encoded = encodeReplyCallback(value);
			expect(encoded).toBe(`ia1:${value}`);
			expect(isInteractionCallback(encoded)).toBe(true);
			expect(decodeCallback(encoded)).toEqual({ kind: "reply", value });
		},
	);

	it.each(["a".repeat(61), "💖".repeat(16)])(
		"rejects oversized UTF-8 payload %j",
		(value) => {
			expect(encodeReplyCallback(value)).toBeNull();
		},
	);

	it("applies a connector's custom byte budget to the complete encoded payload", () => {
		expect(encodeReplyCallback("hi", { maxBytes: 6 })).toBe("ia1:hi");
		expect(encodeReplyCallback("hi", { maxBytes: 5 })).toBeNull();
	});

	it.each([null, 42, "", "other:yes"])(
		"rejects foreign callback %j",
		(value) => {
			expect(isInteractionCallback(value)).toBe(false);
			expect(decodeCallback(value)).toBeNull();
		},
	);
});
