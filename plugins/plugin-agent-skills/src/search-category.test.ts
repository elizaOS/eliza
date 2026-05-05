import type {
	IAgentRuntime,
	SearchCategoryRegistration,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	registerAgentSkillsSearchCategory,
	SKILLS_SEARCH_CATEGORY,
} from "./search-category";

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

describe("Agent Skills search category", () => {
	it("registers skill registry search metadata", () => {
		const { categories, registerSearchCategory, runtime } = createRuntime();

		registerAgentSkillsSearchCategory(runtime);
		registerAgentSkillsSearchCategory(runtime);

		expect(registerSearchCategory).toHaveBeenCalledTimes(1);
		expect(categories.get("skills")).toMatchObject({
			category: "skills",
			serviceType: "AGENT_SKILLS_SERVICE",
			source: "plugin:agent-skills",
		});
		expect(SKILLS_SEARCH_CATEGORY.filters?.map((filter) => filter.name)).toEqual(
			expect.arrayContaining([
				"query",
				"limit",
				"forceRefresh",
				"notOlderThan",
			]),
		);
	});
});
