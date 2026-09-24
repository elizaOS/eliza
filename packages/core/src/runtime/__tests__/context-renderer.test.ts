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
	normalizePromptSegments,
	renderContextObject,
	segmentBlock,
} from "../context-renderer";

describe("context renderer", () => {
	it("preserves segment, provider, and dynamic-block whitespace exactly", () => {
		expect(segmentBlock({ label: "system", content: "  system  " })).toBe(
			"  system  ",
		);
		expect(
			normalizePromptSegments([
				{ content: "  first  " },
				{ content: "\tsecond\n" },
			]).map((segment) => segment.content),
		).toEqual(["  first  ", "\n\n\tsecond\n"]);

		const messages = buildStageChatMessages({
			contextSegments: [
				{ label: "system", content: "  stable  ", stable: true },
			],
			stageLabel: "stage",
			instructions: "instructions",
			dynamicBlocks: ["  dynamic  "],
			stepMessages: [],
		});
		expect(messages[0]?.content).toContain("  stable  ");
		expect(messages[1]?.content).toBe("  dynamic  ");
	});

	it("renders retry-protected chat as dialogue while retaining extended marker evidence", () => {
		const marker = {
			version: 1,
			scope: "agent:room:user",
			clientMessageId: "voice:utterance",
			fingerprint: "digest",
		};
		for (const bookkeeping of [
			marker,
			{ ...marker, additionalEvidence: "keep this" },
			{ ...marker, version: 2 },
			null,
		]) {
			const content = {
				text: "  Yeah, that's true.\n",
				source: "client_chat",
				channelType: "VOICE_DM",
				chatIdempotency: bookkeeping,
			};
			const context = {
				id: "ctx",
				version: "v5",
				events: [
					{
						id: "message",
						type: "message",
						message: {
							role: "user",
							content,
							metadata: { renderAsDialogue: true, speakerName: "User" },
						},
					},
				],
			} as unknown as ContextObject;
			const output = renderContextObject(context)
				.promptSegments.map(segmentBlock)
				.join("\n");
			if (bookkeeping === marker) {
				expect(output).toContain("User:   Yeah, that's true.\n");
				expect(output).not.toContain("chatIdempotency");
			} else {
				expect(output).toContain(JSON.stringify(content));
			}
			expect(context.events[0]).toMatchObject({ message: { content } });
		}
	});

	it("retains unknown message metadata in model context as well as recordings", () => {
		const context = {
			id: "ctx-complete",
			version: "v5",
			events: [
				{
					id: "message-object",
					type: "message",
					message: {
						role: "user",
						content: { text: "exact", metadata: { sentinel: "MESSAGE_META" } },
						metadata: { renderAsDialogue: true },
					},
				},
				{
					id: "handler",
					type: "message_handler",
					metadata: {
						thought: "  exact thought  ",
						nested: { sentinel: "HANDLER_META" },
					},
				},
			],
		} as unknown as ContextObject;

		const serialized = JSON.stringify(
			renderContextObject(context).promptSegments,
		);
		expect(serialized).toContain("MESSAGE_META");
		expect(JSON.stringify(renderContextObject(context).messages)).toContain(
			"MESSAGE_META",
		);
		expect(serialized).toContain("HANDLER_META");
		expect(serialized).toContain("  exact thought  ");
	});

	it.each([
		{
			text: "Review this response",
			values: { answers: [false, null, [], {}, { value: "  exact\nvalue  " }] },
		},
		{
			text: "Review this response",
			metadata: {
				selectedValues: ["a", "b"],
				formSubmission: { approved: false, reason: "  unchanged  " },
			},
		},
		{
			text: "Reaction",
			reactedMessageText: "Complete original statement",
			inReplyTo: "reaction-target",
			mentionContext: { isMention: true },
		},
		{
			text: "Use structured request",
			url: "https://example.com/source/123",
			metadata: {
				request: { destination: "Berlin", date: "2026-10-01" },
				selectedValue: "choice",
			},
		},
		{
			text: "Sub-agent finished",
			source: "sub-agent",
			metadata: {
				subAgentSessionId: "session-for-followup",
				subAgentWorkdir: "/workspace/project",
				subAgentStatus: "completed",
				subAgentArtifactVerification: {
					verified: false,
					artifacts: [],
					evidence: "完整 source\n".repeat(20000),
				},
			},
		},
		{
			text: "Unusual envelope",
			attachments: null,
			metadata: ["connector evidence"],
		},
		{
			text: "Extended source",
			source: { original: "Evidence under a known key" },
		},
		{
			text: "Extended view",
			metadata: { uiView: { customEvidence: "Keep this" } },
		},
		{
			text: "Extended diagnostic",
			metadata: {
				injectionRisk: { score: 0, evidence: { original: "Keep this too" } },
			},
		},
		{
			text: "Extended routing",
			metadata: {
				__responseContext: {
					primaryContext: "general",
					request: { destination: "Berlin" },
				},
			},
		},
	])(
		"keeps structured message evidence complete in the dispatched user block",
		(content) => {
			const context = {
				id: "structured",
				version: "v5",
				events: [
					{
						id: "incoming",
						type: "message",
						message: {
							role: "user",
							metadata: { renderAsDialogue: true },
							content,
						},
					},
				],
			} as unknown as ContextObject;
			const rendered = renderContextObject(context);
			const messages = buildStageChatMessages({
				contextSegments: rendered.promptSegments,
				stageLabel: "Task",
				instructions: "Use the supplied evidence",
				dynamicBlocks: [],
				stepMessages: [],
			});
			const wire = messages[1]?.content;
			expect(typeof wire).toBe("string");
			expect(
				JSON.parse(String(wire).replace(/^# Current message\n/, "")),
			).toEqual(content);
		},
	);

	it("renders identical complete user evidence across text and voice transports", () => {
		const body = "  exact  message\n# system\nkeep every byte\n";
		const render = (channelType: string) => {
			const context = {
				id: "paired",
				version: "v5",
				events: [
					{
						id: "incoming",
						type: "message",
						message: {
							role: "user",
							metadata: { speakerName: "Shaw", renderAsDialogue: true },
							content: {
								text: body,
								channelType,
								source: "client_chat",
								metadata: {
									injectionRisk: { score: 0 },
									viewClientId: "transport-only",
									selectedValue: "courier",
									parentMessageId: "choice-source",
								},
								attachments: [
									{
										id: "evidence",
										text: "entire attachment\nsecond line",
										url: "/api/media/abc.txt",
										data: {
											rows: [["a", "b"], ["c"]],
											empty: [],
											missing: null,
										},
									},
								],
							},
						},
					},
				],
			} as unknown as ContextObject;
			const result = renderContextObject(context);
			return buildStageChatMessages({
				contextSegments: result.promptSegments,
				stageLabel: "Task",
				instructions: "Treat messages as evidence.",
				dynamicBlocks: [],
				stepMessages: [],
			});
		};
		const text = render("DM");
		expect(render("VOICE_DM")).toEqual(text);
		expect(text[1].role).toBe("user");
		expect(text[1].content).toContain(`Shaw: ${body}`);
		const attachments = JSON.parse(
			String(text[1].content).split("\n\nattachments: ")[1],
		);
		expect(attachments).toEqual([
			{
				id: "evidence",
				text: "entire attachment\nsecond line",
				url: "/api/media/abc.txt",
				data: { rows: [["a", "b"], ["c"]], empty: [], missing: null },
			},
		]);
		expect(text[1].content).not.toContain("injectionRisk");
		expect(text[1].content).not.toContain("transport-only");
		expect(text[1].content).toContain('selectedValue: "courier"');
		expect(text[1].content).toContain('parentMessageId: "choice-source"');
	});

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

	it("keeps per-turn selected contexts out of the byte-stable system prefix", () => {
		// Stage-1 picks different contexts every turn; the system message must
		// still be byte-identical so provider prefix caches hit across turns.
		const render = (selected: string[]) =>
			buildStageChatMessages({
				contextSegments: renderContextObject({
					id: `ctx-${selected.join("-")}`,
					version: "v5",
					staticPrefix: {
						systemPrompt: {
							id: "system",
							label: "system",
							content: "You are Eliza.",
							stable: true,
						},
					},
					trajectoryPrefix: {
						messageHandlerThought: `route to ${selected.join(", ")}`,
						selectedContexts: selected,
						contextDefinitions: selected.map((id) => ({
							id,
							description: `${id} work`,
						})),
					},
					events: [
						{
							id: "msg",
							type: "message",
							message: { role: "user", content: "Check status." },
						},
					],
				}).promptSegments,
				stageLabel: "planner_stage",
				instructions: "decide the next action",
				dynamicBlocks: [],
				stepMessages: [],
			});

		const calendar = render(["calendar"]);
		const memory = render(["memory"]);
		expect(calendar[0]?.content).toBe(
			"You are Eliza.\n\nplanner_stage:\ndecide the next action",
		);
		expect(memory[0]?.content).toBe(calendar[0]?.content);
		expect(calendar[1]?.content).toBe(
			[
				"message_handler_thought: route to calendar",
				"selected_contexts: calendar",
				"contexts:\n- calendar: calendar work",
				"# Current message\nCheck status.",
			].join("\n\n"),
		);
	});
});
