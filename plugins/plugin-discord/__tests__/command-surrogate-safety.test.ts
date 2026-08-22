/**
 * Regression tests for surrogate-safe truncation in Discord catalog commands
 * (slash choice names) and native commands (button labels).
 *
 * Ensures that 100-character slash choice names and 80-character button labels
 * back off safely when landing on a UTF-16 surrogate pair (e.g. emojis),
 * preventing Discord REST API 400 rejection (Invalid Form Body / Invalid Unicode).
 */

import { describe, expect, it } from "vitest";
import { mapOption } from "../catalog-commands";
import { buildCommandArgMenu } from "../native-commands";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	for (let i = 0; i < value.length; i++) {
		const c = value.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff) {
			const n = value.charCodeAt(i + 1);
			if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
			i++;
		} else if (c >= 0xdc00 && c <= 0xdfff) return false;
	}
	return true;
}

describe("catalog-commands mapOption surrogate safety", () => {
	it("preserves choices <= 100 characters intact", () => {
		const opt = mapOption({
			name: "theme",
			description: "Theme choice",
			required: false,
			choices: ["dark", "light", "solarized"],
		});

		expect(opt.choices).toEqual([
			{ name: "dark", value: "dark" },
			{ name: "light", value: "light" },
			{ name: "solarized", value: "solarized" },
		]);
	});

	it("backs off surrogate pair that straddles the 100-char boundary in slash choices", () => {
		const diamond = String.fromCharCode(0xd83d, 0xdc8e); // 💎 = \uD83D\uDC8E
		// 99 standard chars + 2-char diamond (units 99..100) + tail: diamond straddles index 99..100
		const rawChoice = `${"d".repeat(99)}${diamond}${"extra".repeat(10)}`;

		const opt = mapOption({
			name: "badge",
			description: "Badge name",
			required: true,
			choices: [rawChoice],
		});

		expect(opt.choices).toBeDefined();
		const mapped = opt.choices?.[0];
		expect(isWellFormed(mapped.name)).toBe(true);
		expect(() => JSON.stringify(mapped)).not.toThrow();
		expect(mapped.name.length).toBeLessThanOrEqual(100);
		// Backs off the high surrogate: 99 characters
		expect(mapped.name.length).toBe(99);
		expect(mapped.name).toBe("d".repeat(99));
		expect(mapped.name).not.toContain("\uD83D");
	});

	it("keeps full surrogate pair when fitting wholly inside 100 characters", () => {
		const diamond = String.fromCharCode(0xd83d, 0xdc8e); // 💎
		// 98 standard chars + 2-char diamond = 100 chars
		const rawChoice = `${"d".repeat(98)}${diamond}${"extra".repeat(10)}`;

		const opt = mapOption({
			name: "badge",
			description: "Badge name",
			required: true,
			choices: [rawChoice],
		});

		expect(opt.choices).toBeDefined();
		const mapped = opt.choices?.[0];
		expect(isWellFormed(mapped.name)).toBe(true);
		expect(mapped.name.length).toBe(100);
		expect(mapped.name).toBe(`${"d".repeat(98)}${diamond}`);
	});
});

describe("native-commands buildCommandArgMenu surrogate safety", () => {
	it("backs off surrogate pair straddling the 80-char button label boundary", () => {
		const fire = String.fromCharCode(0xd83d, 0xdd25); // 🔥 = \uD83D\uDD25
		// 79 standard chars + 2-char fire (units 79..80) + tail
		const longLabel = `${"b".repeat(79)}${fire}${"tail".repeat(10)}`;

		const result = buildCommandArgMenu({
			commandName: "mode",
			arg: { name: "level", description: "Mode level", type: "string" },
			choices: [{ label: longLabel, value: "fire_mode" }],
			userId: "user-123",
		});

		expect(result.rows).toHaveLength(1);
		const button = result.rows[0].buttons[0];
		expect(isWellFormed(button.label)).toBe(true);
		expect(() => JSON.stringify(button)).not.toThrow();
		expect(button.label.length).toBeLessThanOrEqual(80);
		// Backs off the high surrogate: 79 characters
		expect(button.label.length).toBe(79);
		expect(button.label).toBe("b".repeat(79));
		expect(button.label).not.toContain("\uD83D");
	});

	it("keeps full surrogate pair when button label fits within 80 characters", () => {
		const fire = String.fromCharCode(0xd83d, 0xdd25); // 🔥
		const longLabel = `${"b".repeat(78)}${fire}${"tail".repeat(10)}`;

		const result = buildCommandArgMenu({
			commandName: "mode",
			arg: { name: "level", description: "Mode level", type: "string" },
			choices: [{ label: longLabel, value: "fire_mode" }],
			userId: "user-123",
		});

		const button = result.rows[0].buttons[0];
		expect(isWellFormed(button.label)).toBe(true);
		expect(button.label.length).toBe(80);
		expect(button.label).toBe(`${"b".repeat(78)}${fire}`);
	});
});
