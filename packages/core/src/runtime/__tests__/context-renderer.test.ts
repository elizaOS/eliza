import { describe, expect, it } from "vitest";
import type { ContextObject } from "../../types/context-object";
import { renderContextObject } from "../context-renderer";

describe("context renderer", () => {
	it("renders provider and tool prefixes before append-only events", () => {
		const context: ContextObject = {
			id: "ctx",
			version: "v5",
			staticPrefix: {
				staticProviders: [
					{
						id: "static-provider",
						label: "provider:profile",
						content: "profile_provider: user prefers terse replies",
						stable: true,
					},
				],
				alwaysTools: [
					{
						name: "ALWAYS_AVAILABLE",
						description: "Always available tool",
						type: "function",
					},
				],
			},
			trajectoryPrefix: {
				contextProviders: [
					{
						id: "trajectory-provider",
						label: "provider:web",
						content: "web_provider: search corpus is enabled",
						stable: false,
					},
				],
				expandedTools: [
					{
						name: "WEB_SEARCH",
						description: "Search the web",
						type: "function",
					},
				],
			},
			events: [
				{
					id: "current-message",
					type: "message",
					message: {
						id: "msg",
						role: "user",
						content: "Find the latest docs.",
					},
				},
			],
		};

		const rendered = renderContextObject(context);

		expect(rendered.promptSegments.map((segment) => segment.id)).toEqual([
			"static-provider",
			"trajectory-provider",
			"tool:ALWAYS_AVAILABLE",
			"tool:WEB_SEARCH",
			"msg",
		]);
		expect(rendered.promptSegments.map((segment) => segment.content)).toEqual([
			"profile_provider: user prefers terse replies",
			"web_provider: search corpus is enabled",
			"tool: ALWAYS_AVAILABLE\ndescription: Always available tool",
			"tool: WEB_SEARCH\ndescription: Search the web",
			"Find the latest docs.",
		]);
		expect(rendered.tools.map((tool) => tool.name)).toEqual([
			"ALWAYS_AVAILABLE",
			"WEB_SEARCH",
		]);
	});
});
