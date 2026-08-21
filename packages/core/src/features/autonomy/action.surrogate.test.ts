/** Surrogate safety for targetRoomId preview in autonomy action.ts. */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../../utils/well-formed.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

function formatRoomPreview(targetRoomId: string): string {
	const roomPreview = truncateWellFormed(
		toWellFormedUnicode(String(targetRoomId)),
		8,
	);
	return `Message sent to admin in room ${roomPreview}...`;
}

describe("autonomy action targetRoomId preview surrogate safety", () => {
	test("emoji at 7 boundary backs off without lone surrogate", () => {
		const fox = "🦊";
		const roomId = `${"a".repeat(7)}${fox}${"b".repeat(20)}`;
		const msg = formatRoomPreview(roomId);
		expect(isWellFormed(msg)).toBe(true);
		expect(msg.startsWith("Message sent to admin in room aaaaaaa...")).toBe(
			true,
		);
		expect(() => JSON.stringify({ msg })).not.toThrow();
	});

	test("fitting emoji ending at 8 kept intact", () => {
		const fox = "🦊";
		const roomId = `${"a".repeat(6)}${fox}`;
		const msg = formatRoomPreview(roomId);
		expect(isWellFormed(msg)).toBe(true);
		expect(msg.includes(fox)).toBe(true);
	});

	test("lone high surrogate in room id sanitized safely", () => {
		const badRoomId = "room\ud800123456";
		const msg = formatRoomPreview(badRoomId);
		expect(isWellFormed(msg)).toBe(true);
		expect(msg.includes("\ud800")).toBe(false);
	});

	test("sweep offsets around 8 cap all stay well-formed", () => {
		const fox = "🦊";
		for (let offset = -4; offset <= 4; offset++) {
			const n = 8 + offset;
			const roomId = `${"a".repeat(n)}${fox}${"b".repeat(10)}`;
			const msg = formatRoomPreview(roomId);
			expect(isWellFormed(msg)).toBe(true);
			expect(() => JSON.stringify({ msg })).not.toThrow();
		}
	});
});
