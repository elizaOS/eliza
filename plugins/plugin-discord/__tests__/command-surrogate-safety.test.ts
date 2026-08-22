/**
 * Verifies Discord protocol-length projections remain valid Unicode without
 * changing the connector's existing fixed-choice registration semantics.
 */

import { ElizaError } from "@elizaos/core";
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

	it("preserves all 25 choices representable by Discord button rows", () => {
		const choices = Array.from({ length: 25 }, (_, index) => ({
			label: `Choice ${index}`,
			value: `choice-${index}`,
		}));
		const menu = buildCommandArgMenu({
			commandName: "mode",
			arg: { name: "level", description: "Mode level", type: "string" },
			choices,
			userId: "user-123",
		});

		expect(menu.rows).toHaveLength(5);
		expect(menu.rows.flatMap((row) => row.buttons)).toHaveLength(25);
		expect(menu.rows[4]?.buttons[4]?.customId).toContain("value=choice-24");
	});

	it("rejects choices that require pagination instead of silently dropping them", () => {
		const choices = Array.from({ length: 26 }, (_, index) => ({
			label: `Choice ${index}`,
			value: `choice-${index}`,
		}));

		let caught: unknown;
		try {
			buildCommandArgMenu({
				commandName: "mode",
				arg: { name: "level", description: "Mode level", type: "string" },
				choices,
				userId: "user-123",
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ElizaError);
		const typed = caught as ElizaError;
		expect(typed.code).toBe("DISCORD_COMMAND_MENU_CHOICES_EXCEED_CAPACITY");
		expect(typed.message).toContain("use pagination or autocomplete instead");
		expect(typed.context).toMatchObject({
			commandName: "mode",
			arg: "level",
			choiceCount: 26,
			maxChoices: 25,
			buttonsPerRow: 5,
		});
	});

	it("rejects an out-of-range buttonsPerRow with a typed error", () => {
		let caught: unknown;
		try {
			buildCommandArgMenu({
				commandName: "mode",
				arg: { name: "level", description: "Mode level", type: "string" },
				choices: [{ label: "A", value: "a" }],
				userId: "user-123",
				buttonsPerRow: 6,
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ElizaError);
		expect((caught as ElizaError).code).toBe(
			"DISCORD_COMMAND_MENU_INVALID_ROW_WIDTH",
		);
	});
});
