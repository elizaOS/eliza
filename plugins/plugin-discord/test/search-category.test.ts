import type {
	IAgentRuntime,
	SearchCategoryRegistration,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	DISCORD_MESSAGES_SEARCH_CATEGORY,
	registerDiscordSearchCategory,
} from "../search-category";

function createRuntime() {
	const categories = new Map<string, SearchCategoryRegistration>();
	const registerSearchCategory = vi.fn(
		(registration: SearchCategoryRegistration) => {
			categories.set(registration.category, registration);
		},
	);
	const getSearchCategory = vi.fn((category: string) => {
		const registration = categories.get(category);
		if (!registration) throw new Error(`Missing category ${category}`);
		return registration;
	});

	return {
		categories,
		registerSearchCategory,
		runtime: { getSearchCategory, registerSearchCategory } as unknown as
			IAgentRuntime,
	};
}

describe("Discord search category", () => {
	it("registers Discord message search filters", () => {
		const { categories, registerSearchCategory, runtime } = createRuntime();

		registerDiscordSearchCategory(runtime);
		registerDiscordSearchCategory(runtime);

		expect(registerSearchCategory).toHaveBeenCalledTimes(1);
		expect(categories.get("discord_messages")).toMatchObject({
			category: "discord_messages",
			serviceType: "discord",
			source: "plugin:discord",
		});
		expect(
			DISCORD_MESSAGES_SEARCH_CATEGORY.filters?.map((filter) => filter.name),
		).toEqual(
			expect.arrayContaining([
				"query",
				"channelIdentifier",
				"author",
				"timeRange",
				"limit",
			]),
		);
	});
});
