/**
 * Verifies Discord protocol-length projections remain valid Unicode without
 * changing the connector's existing fixed-choice registration semantics.
 */

import { describe, expect, it } from "vitest";
import { mapOption } from "../catalog-commands";
import { buildCommandArgMenu } from "../native-commands";

describe("Discord command projection Unicode safety", () => {
	it("keeps a complete surrogate pair when it fits the 100-unit choice limit", () => {
		const emoji = "💎";
		const option = mapOption({
			name: "badge",
			description: "Badge name",
			required: true,
			choices: [`${"d".repeat(98)}${emoji}tail`],
		});

		expect(option.choices?.[0]?.name).toBe(`${"d".repeat(98)}${emoji}`);
	});

	it("does not split a surrogate pair at the 100-unit choice limit", () => {
		const option = mapOption({
			name: "badge",
			description: "Badge name",
			required: true,
			choices: [`${"d".repeat(99)}💎tail`],
		});

		expect(option.choices?.[0]?.name).toBe("d".repeat(99));
		expect(option.choices?.[0]?.name.isWellFormed()).toBe(true);
	});

	it("preserves the existing dynamic-choice behavior above Discord's 25-choice limit", () => {
		const option = mapOption({
			name: "theme",
			description: "Theme name",
			required: false,
			choices: Array.from({ length: 26 }, (_, index) => `theme-${index}`),
		});

		expect(option.choices).toBeUndefined();
	});

	it("keeps a complete surrogate pair when it fits the 80-unit label limit", () => {
		const menu = buildCommandArgMenu({
			commandName: "mode",
			arg: { name: "level", description: "Mode level", type: "string" },
			choices: [{ label: `${"b".repeat(78)}🔥tail`, value: "fire" }],
			userId: "user-123",
		});

		expect(menu.rows[0]?.buttons[0]?.label).toBe(`${"b".repeat(78)}🔥`);
	});

	it("does not split a surrogate pair at the 80-unit label limit", () => {
		const menu = buildCommandArgMenu({
			commandName: "mode",
			arg: { name: "level", description: "Mode level", type: "string" },
			choices: [{ label: `${"b".repeat(79)}🔥tail`, value: "fire" }],
			userId: "user-123",
		});

		const label = menu.rows[0]?.buttons[0]?.label;
		expect(label).toBe("b".repeat(79));
		expect(label?.isWellFormed()).toBe(true);
	});
});
