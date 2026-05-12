import { describe, expect, it } from "vitest";
import { isDiscordUserAddressed } from "../addressing";

describe("isDiscordUserAddressed", () => {
	it("treats the first user mention as the addressed recipient", () => {
		expect(
			isDiscordUserAddressed({
				text: "<@123> please check this with <@456>",
				userId: "123",
			}),
		).toBe(true);
	});

	it("does not treat later user mentions as direct addressing", () => {
		expect(
			isDiscordUserAddressed({
				text: "<@456> please compare this with <@123>",
				userId: "123",
			}),
		).toBe(false);
	});

	it("treats replies to the bot as addressed", () => {
		expect(
			isDiscordUserAddressed({
				text: "one more thing",
				userId: "123",
				hasMessageReference: true,
				repliedUserId: "123",
			}),
		).toBe(true);
	});

	it("supports Discord's nickname mention form", () => {
		expect(
			isDiscordUserAddressed({
				text: "<@!123> please check this",
				userId: "123",
			}),
		).toBe(true);
	});
});
