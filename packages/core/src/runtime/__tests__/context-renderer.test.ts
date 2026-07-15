/**
 * Covers the context renderer: `renderContextObject` orders provider and tool
 * prefixes ahead of append-only events without duplicating native tools as text
 * segments, `buildStageChatMessages` splits a stage call into one cacheable
 * system prefix plus a dynamic user block, and `cachePrefixSegments` keeps only
 * the longest leading stable-prefix run for cache keys. Pure, no model.
 */
import { describe, expect, it } from "vitest";
import type { ContextObject } from "../../types/context-object";
import {
	buildStageChatMessages,
	cachePrefixSegments,
	renderContextObject,
} from "../context-renderer";

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
		// Native tools are sent on the wire, so `renderPrefixTool` must not also
		// emit a `tool: NAME\ndescription: ...` text segment in the system
		// prompt: a text duplicate inflates prompt tokens and gives the model two
		// representations of the same surface to reconcile.
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
		// And no segment whose content begins with `tool: ` (the forbidden
		// text-tool shape).
		for (const segment of rendered.promptSegments) {
			expect(segment.content).not.toMatch(/^tool:\s*[A-Z_]/);
		}
	});

	it("builds one cacheable system prefix and one dynamic user block for stage calls", () => {
		const messages = buildStageChatMessages({
			contextSegments: [
				{
					content:
						"Character system.\n\n# About Test Agent\nBio.\n\nuser_role: ADMIN",
					label: "system",
					stable: true,
				},
				{
					content: "selected_contexts: calendar",
					label: "system",
					stable: true,
				},
				{
					content: "current_message: Can you check my calendar?",
					label: "message",
					stable: false,
				},
			],
			stageLabel: "planner_stage",
			instructions: "Plan the next action.",
			dynamicBlocks: ["runtime_hint: current turn only"],
			stepMessages: [{ role: "assistant", content: "previous result" }],
		});

		expect(messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"assistant",
		]);
		expect(messages[0]?.content).toBe(
			[
				"Character system.\n\n# About Test Agent\nBio.\n\nuser_role: ADMIN",
				"selected_contexts: calendar",
				"planner_stage:\nPlan the next action.",
			].join("\n\n"),
		);
		expect(messages[1]?.content).toBe(
			[
				"message:\ncurrent_message: Can you check my calendar?",
				"runtime_hint: current turn only",
			].join("\n\n"),
		);
	});

	it("uses the longest stable prefix for provider cache keys", () => {
		expect(
			cachePrefixSegments([
				{ content: "system", stable: true },
				{ content: "stable provider", stable: true },
				{ content: "current message", stable: false },
				{ content: "late stable should not count", stable: true },
			]),
		).toEqual([
			{ content: "system", stable: true },
			{ content: "stable provider", stable: true },
		]);
	});

	it("marks a provider event's segment stable per its cacheStable flag", () => {
		const context: ContextObject = {
			id: "ctx",
			version: "v5",
			events: [
				{
					id: "provider:STABLE_DOCTRINE",
					type: "provider",
					name: "STABLE_DOCTRINE",
					text: "doctrine: ship velocity outranks deliberation",
					cacheStable: true,
				},
				{
					id: "provider:VOLATILE_FEED",
					type: "provider",
					name: "VOLATILE_FEED",
					text: "feed: latest market snapshot",
					cacheStable: false,
				},
				{
					id: "provider:UNSET",
					type: "provider",
					name: "UNSET",
					text: "unset: defaults to volatile",
				},
			],
		};

		const rendered = renderContextObject(context);

		// The segment's `stable` flag now reflects the provider's declared
		// cacheStable, so buildStageChatMessages can route the stable one into
		// the cached system message. Unset defaults to volatile.
		expect(
			rendered.promptSegments.map((segment) => ({
				id: segment.id,
				stable: segment.stable,
			})),
		).toEqual([
			{ id: "provider:STABLE_DOCTRINE", stable: true },
			{ id: "provider:VOLATILE_FEED", stable: false },
			{ id: "provider:UNSET", stable: false },
		]);
	});

	it("buckets a stable provider event into the cached system message", () => {
		const context: ContextObject = {
			id: "ctx",
			version: "v5",
			events: [
				{
					id: "provider:STABLE_DOCTRINE",
					type: "provider",
					name: "STABLE_DOCTRINE",
					text: "doctrine: ship velocity outranks deliberation",
					cacheStable: true,
				},
				{
					id: "provider:VOLATILE_FEED",
					type: "provider",
					name: "VOLATILE_FEED",
					text: "feed: latest market snapshot",
					cacheStable: false,
				},
			],
		};

		const messages = buildStageChatMessages({
			contextSegments: renderContextObject(context).promptSegments,
			stageLabel: "planner_stage",
			instructions: "decide the next action",
			dynamicBlocks: [],
			stepMessages: [],
		});

		const system = messages.find((message) => message.role === "system");
		const user = messages.find((message) => message.role === "user");
		expect(system?.content).toContain(
			"doctrine: ship velocity outranks deliberation",
		);
		expect(user?.content).toContain("feed: latest market snapshot");
		expect(system?.content).not.toContain("feed: latest market snapshot");
	});
});
