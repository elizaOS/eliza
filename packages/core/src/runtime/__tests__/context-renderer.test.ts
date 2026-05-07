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

		// Tools are registered natively in `rendered.tools` and sent on the
		// wire via the request's `tools` field. They are NOT also stamped as
		// text segments in the system prompt — duplicating the catalog wastes
		// prompt tokens and gives the model two representations to reconcile.
		expect(rendered.promptSegments.map((segment) => segment.id)).toEqual([
			"static-provider",
			"trajectory-provider",
			"msg",
		]);
		expect(rendered.promptSegments.map((segment) => segment.content)).toEqual([
			"profile_provider: user prefers terse replies",
			"web_provider: search corpus is enabled",
			"Find the latest docs.",
		]);
		expect(rendered.tools.map((tool) => tool.name)).toEqual([
			"ALWAYS_AVAILABLE",
			"WEB_SEARCH",
		]);
	});

	it("does not emit synthetic tool-text segments alongside native tools", () => {
		// Regression: `renderPrefixTool` previously emitted both the native
		// tool definition AND a `tool: NAME\ndescription: ...` text segment in
		// the system prompt. Native tools are sent on the wire; the text
		// duplicate inflated prompt tokens and confused models that saw the
		// same surface area twice.
		const context: ContextObject = {
			id: "ctx-no-text",
			version: "v5",
			staticPrefix: {
				alwaysTools: [
					{ name: "X", description: "X tool", type: "function" },
					{ name: "Y", description: "Y tool", type: "function" },
				],
			},
			trajectoryPrefix: {
				expandedTools: [{ name: "Z", description: "Z tool", type: "function" }],
			},
			events: [],
		};
		const rendered = renderContextObject(context);
		expect(rendered.tools.map((tool) => tool.name)).toEqual(["X", "Y", "Z"]);
		expect(rendered.promptSegments).toHaveLength(0);
		// And no segment whose content begins with `tool: ` (the old shape).
		for (const segment of rendered.promptSegments) {
			expect(segment.content).not.toMatch(/^tool:\s*[A-Z_]/);
		}
	});
});
