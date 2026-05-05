import type {
	Action,
	ActionResult,
	IAgentRuntime,
	Memory,
	SearchCategoryRegistration,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
	installAgentSkillsSearchDispatcher,
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

	it("dispatches unified SEARCH category=skills through AgentSkillsService", async () => {
		const search = vi.fn(async () => [
			{
				slug: "data-analysis",
				displayName: "Data Analysis",
				summary: "Analyze datasets",
			},
		]);
		const service = {
			search,
			getLoadedSkill: vi.fn(() => undefined),
			isSkillEnabled: vi.fn(() => false),
		};
		const originalHandler = vi.fn(async (): Promise<ActionResult> => ({
			success: false,
			values: { error: "UNSUPPORTED_CATEGORY", category: "skills" },
			data: { actionName: "SEARCH", category: "skills" },
		}));
		const searchAction: Action = {
			name: "SEARCH",
			description: "Search",
			validate: vi.fn(async () => true),
			handler: originalHandler,
		};
		const runtime = {
			actions: [searchAction],
			getService: vi.fn((name: string) =>
				name === "AGENT_SKILLS_SERVICE" ? service : undefined,
			),
			getServicesByType: vi.fn(() => []),
		} as unknown as IAgentRuntime;
		const message = {
			content: { text: "ignored", source: "test" },
		} as unknown as Memory;
		const callback = vi.fn(async () => []);

		expect(installAgentSkillsSearchDispatcher(runtime)).toBe(true);
		expect(installAgentSkillsSearchDispatcher(runtime)).toBe(false);

		const result = await searchAction.handler(
			runtime,
			message,
			undefined,
			{
				parameters: {
					category: "skills",
					query: "data analysis",
					limit: 3,
				},
			},
			callback,
		);

		expect(originalHandler).not.toHaveBeenCalled();
		expect(search).toHaveBeenCalledWith("data analysis", 3, {
			forceRefresh: false,
		});
		expect(result?.success).toBe(true);
		expect(result?.data).toMatchObject({
			actionName: "SEARCH",
			category: "skills",
			query: "data analysis",
		});
		expect(result?.text).toContain("skills_search:");
		expect(callback).toHaveBeenCalledWith({
			text: expect.stringContaining("results[1]"),
		});
	});
});
