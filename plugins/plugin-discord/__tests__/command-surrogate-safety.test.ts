/**
 * Verifies Discord protocol-length projections remain valid Unicode without
 * changing the connector's existing fixed-choice registration semantics.
 */

import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { mapOption } from "../catalog-commands";
import {
	buildCommandArgCustomId,
	buildCommandArgMenu,
	buildDiscordCommandOptions,
} from "../native-commands";

describe("Discord command projection Unicode safety", () => {
	it("omits a fixed catalog choice whose complete value exceeds the limit", () => {
		const emoji = "💎";
		const option = mapOption({
			name: "badge",
			description: "Badge name",
			required: true,
			choices: [`${"d".repeat(98)}${emoji}tail`],
		});

		expect(option.choices).toBeUndefined();
	});

	it("omits a fixed catalog choice that cannot fit without splitting Unicode", () => {
		const option = mapOption({
			name: "badge",
			description: "Badge name",
			required: true,
			choices: [`${"d".repeat(99)}💎tail`],
		});

		expect(option.choices).toBeUndefined();
	});

	it("hardens the native slash-command choice projection", () => {
		const options = buildDiscordCommandOptions([
			{
				name: "badge",
				description: "Badge name",
				type: "string",
				choices: [{ label: `${"d".repeat(99)}💎tail`, value: "diamond" }],
			},
		]);

		expect(options?.[0]?.choices?.[0]).toEqual({
			name: "d".repeat(99),
			value: "diamond",
		});
	});

	it("rejects a native slash-command choice with an unrepresentable value", () => {
		expect(() =>
			buildDiscordCommandOptions([
				{
					name: "badge",
					description: "Badge name",
					type: "string",
					choices: [{ label: "Diamond", value: "v".repeat(101) }],
				},
			]),
		).toThrowError(
			expect.objectContaining({
				code: "DISCORD_COMMAND_CHOICE_VALUE_INVALID",
			}),
		);
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

	it("falls back to free text for an empty fixed catalog choice", () => {
		const option = mapOption({
			name: "theme",
			description: "Theme name",
			required: false,
			choices: [""],
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

	it("rejects an empty command button label with a typed error", () => {
		expect(() =>
			buildCommandArgMenu({
				commandName: "mode",
				arg: { name: "level", description: "Mode level", type: "string" },
				choices: [{ label: "", value: "empty" }],
				userId: "user-123",
			}),
		).toThrowError(
			expect.objectContaining({
				code: "DISCORD_COMMAND_BUTTON_LABEL_INVALID",
			}),
		);
	});

	it("accepts a command button custom ID at the exact protocol boundary", () => {
		const fixedLength = buildCommandArgCustomId({
			command: "mode",
			arg: "level",
			value: "",
			userId: "user-123",
		}).length;
		const customId = buildCommandArgCustomId({
			command: "mode",
			arg: "level",
			value: "v".repeat(100 - fixedLength),
			userId: "user-123",
		});

		expect(customId).toHaveLength(100);
	});

	it("rejects a percent-encoded command button custom ID above the limit", () => {
		expect(() =>
			buildCommandArgCustomId({
				command: "mode",
				arg: "level",
				value: "🔥".repeat(20),
				userId: "123456789012345678",
			}),
		).toThrowError(
			expect.objectContaining({
				code: "DISCORD_COMMAND_CUSTOM_ID_TOO_LONG",
			}),
		);
	});
});
