/**
 * Stage-1 prompt rendering and structural addressing use complete canonical
 * instructions while keeping generic name tokens ambient.
 */
import { describe, expect, it, vi } from "vitest";
import {
	BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
	candidateActionNamesFieldEvaluator,
	shouldRespondFieldEvaluator,
} from "../../../../plugins/plugin-assistant/src/runtime/builtin-field-evaluators.ts";
import { isUnaddressedTextGroupTurn } from "../../../../plugins/plugin-assistant/src/services/message/stage1-prompt-tier.ts";
import {
	classifyMessageAddress,
	runV5MessageRuntimeStage1,
	textContainsAgentName,
} from "../../../../plugins/plugin-assistant/src/services/message.ts";
import {
	HANDLE_RESPONSE_SCHEMA,
	HANDLE_RESPONSE_TOOL_NAME,
	SHOULD_RESPOND_SCHEMA_DESCRIPTION,
} from "../actions/to-tool";
import { ContextRegistry } from "../runtime/context-registry";
import { ResponseHandlerFieldRegistry } from "../runtime/response-handler-field-registry";
import type { ContextDefinition } from "../types/contexts";
import type { Memory } from "../types/memory";
import { ChannelType, type UUID } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";

const FULL_TEMPLATE_MARKER = "# Task";
const FULL_SHOULD_RESPOND_DOCS = "stop only on explicit disengagement";

const LONG_CONTEXT_DESCRIPTION =
	"Helpdesk operations of any kind: any imperative ('open a ticket', " +
	"'escalate this', 'check ticket status'), any triage/escalation/assignment " +
	"change, any SLA or priority question, follow-ups the user wants surfaced " +
	"later, and status of their own open tickets. Pick this whenever the user " +
	"asks the assistant to act on a support ticket rather than chat.";

const FIXTURE_CONTEXTS: readonly ContextDefinition[] = [
	{
		id: "general",
		label: "General",
		description: "Normal conversation.",
	},
	{
		id: "helpdesk",
		label: "Helpdesk",
		description: LONG_CONTEXT_DESCRIPTION,
		descriptionCompressed: "Support tickets: open, escalate, check status",
	},
	{
		id: "notes",
		label: "Notes",
		description: "Read, create, update, delete, search, and list sticky notes.",
		descriptionCompressed: "Sticky notes: create, read, update, delete, search",
	},
];

function stage1Response(fields: {
	shouldRespond?: "RESPOND" | "IGNORE" | "STOP";
	contexts?: string[];
	replyText?: string;
}): unknown {
	return {
		text: "",
		toolCalls: [
			{
				id: "handle-response-1",
				name: HANDLE_RESPONSE_TOOL_NAME,
				arguments: {
					shouldRespond: fields.shouldRespond ?? "RESPOND",
					thought: "",
					contexts: fields.contexts ?? [],
					intents: [],
					candidateActionNames: [],
					replyText: fields.replyText ?? "",
					facts: [],
					relationships: [],
					addressedTo: [],
				},
			},
		],
	};
}

function makeMessage(overrides?: {
	channelType?: string;
	mentionContext?: { isMention: boolean; isReply: boolean };
	text?: string;
	contentMetadata?: Record<string, unknown>;
	source?: string;
}): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: {
			text: overrides?.text ?? "anyone seen the new build?",
			source: overrides?.source ?? "discord",
			...(overrides?.channelType !== undefined
				? { channelType: overrides.channelType }
				: {}),
			...(overrides?.mentionContext
				? { mentionContext: overrides.mentionContext }
				: {}),
			...(overrides?.contentMetadata
				? { metadata: overrides.contentMetadata }
				: {}),
		},
		createdAt: 1,
	};
}

function makeState(): State {
	return { values: {}, data: {}, text: "Recent conversation summary" };
}

function makeRuntime(
	stage1ResponseBody: unknown,
	settings: Record<string, string> = {},
): IAgentRuntime {
	const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
	for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
		responseHandlerFieldRegistry.register(evaluator);
	}
	return {
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		character: { name: "Test Agent", system: "You are concise." },
		actions: [],
		providers: FIXTURE_CONTEXTS.map(({ id }) => ({
			name: `${id}-support`,
			contexts: [id],
			get: async () => ({ text: "" }),
		})),
		getRoom: vi.fn(async () => null),
		reportError: vi.fn(),
		contexts: new ContextRegistry(FIXTURE_CONTEXTS),
		getSetting: vi.fn((key: string) => settings[key]),
		responseHandlerFieldRegistry,
		responseHandlerFieldEvaluators: [
			...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
		],
		composeState: vi.fn(async () => makeState()),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		useModel: vi.fn(async () => stage1ResponseBody),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as IAgentRuntime;
}

async function renderedStage1Prompt(
	message: Memory,
	stage1ResponseBody: unknown = stage1Response({
		shouldRespond: "RESPOND",
		replyText: "Hello.",
	}),
	settings: Record<string, string> = {},
): Promise<{
	systemContent: string;
	turnContent: string;
	outcome: Awaited<ReturnType<typeof runV5MessageRuntimeStage1>>;
	runtime: IAgentRuntime;
}> {
	const runtime = makeRuntime(stage1ResponseBody, settings);
	const outcome = await runV5MessageRuntimeStage1({
		runtime,
		message,
		state: makeState(),
		responseId: "00000000-0000-0000-0000-000000000005" as UUID,
	});
	const calls = (runtime.useModel as { mock: { calls: unknown[][] } }).mock
		.calls;
	const params = calls[0]?.[1] as
		| { messages?: Array<{ role?: string; content?: string }> }
		| undefined;
	const messages = params?.messages;
	expect(messages?.map(({ role }) => role)).toEqual(["system", "user"]);
	const systemContent = messages?.[0]?.content ?? "";
	const turnContent = messages?.[1]?.content ?? "";
	expect(systemContent).toContain("You are concise.");
	expect(systemContent).toContain("Never disclose secrets or credentials.");
	expect(systemContent).not.toMatch(/^# Task$/m);
	expect(turnContent).toContain(FULL_TEMPLATE_MARKER);
	expect(turnContent).toContain("# Current message");
	expect(turnContent).toContain(message.content.text);
	return {
		systemContent,
		turnContent,
		outcome,
		runtime,
	};
}

describe("isUnaddressedTextGroupTurn", () => {
	it("accepts an unaddressed text-group message", () => {
		expect(
			isUnaddressedTextGroupTurn(
				makeMessage({ channelType: String(ChannelType.GROUP) }),
				false,
			),
		).toBe(true);
	});

	it("rejects addressed, autonomous, sub-agent, client-chat, and unknown-channel turns", () => {
		const group = makeMessage({ channelType: String(ChannelType.GROUP) });
		expect(isUnaddressedTextGroupTurn(group, true)).toBe(false);
		expect(
			isUnaddressedTextGroupTurn(
				makeMessage({
					channelType: String(ChannelType.GROUP),
					contentMetadata: { isAutonomous: true },
				}),
				false,
			),
		).toBe(false);
		expect(
			isUnaddressedTextGroupTurn(
				makeMessage({
					channelType: String(ChannelType.GROUP),
					contentMetadata: { subAgent: true },
				}),
				false,
			),
		).toBe(false);
		expect(
			isUnaddressedTextGroupTurn(
				makeMessage({
					channelType: String(ChannelType.GROUP),
					source: "client_chat",
				}),
				false,
			),
		).toBe(false);
		// Missing/unknown channel type fails open into the full tier.
		expect(isUnaddressedTextGroupTurn(makeMessage(), false)).toBe(false);
	});
});

describe("Stage-1 complete prompt rendering", () => {
	it("keeps shouldRespond values aligned and guidance in the field prompt", () => {
		expect(shouldRespondFieldEvaluator.schema.enum).toEqual(
			HANDLE_RESPONSE_SCHEMA.properties?.shouldRespond?.enum,
		);
		expect(shouldRespondFieldEvaluator.description).toContain(
			FULL_SHOULD_RESPOND_DOCS,
		);
		expect(HANDLE_RESPONSE_SCHEMA.properties?.shouldRespond?.description).toBe(
			SHOULD_RESPOND_SCHEMA_DESCRIPTION,
		);
	});

	it("renders the full block for an unaddressed group message", async () => {
		const { turnContent, outcome } = await renderedStage1Prompt(
			makeMessage({ channelType: String(ChannelType.GROUP) }),
			stage1Response({ shouldRespond: "IGNORE" }),
		);

		expect(turnContent).toContain(FULL_TEMPLATE_MARKER);
		expect(turnContent).toContain(
			"Support tickets: open, escalate, check status",
		);
		expect(FIXTURE_CONTEXTS[1].description).toBe(LONG_CONTEXT_DESCRIPTION);
		expect(turnContent).not.toContain("## Response Handler Fields");
		// The envelope still parses and routes: IGNORE ends the turn.
		expect(outcome.kind).toBe("terminal");
	});

	it("produces a non-terminal result with the full block when group triage decides RESPOND", async () => {
		const { turnContent, outcome, runtime } = await renderedStage1Prompt(
			makeMessage({ channelType: String(ChannelType.GROUP) }),
			stage1Response({ shouldRespond: "RESPOND", replyText: "Hello." }),
		);

		expect(turnContent).toContain(FULL_TEMPLATE_MARKER);
		expect(turnContent).toContain(
			"Support tickets: open, escalate, check status",
		);
		expect(FIXTURE_CONTEXTS[1].description).toBe(LONG_CONTEXT_DESCRIPTION);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(outcome.kind).not.toBe("terminal");
	});

	it("renders the full rule block when the agent is platform-mentioned", async () => {
		const { turnContent } = await renderedStage1Prompt(
			makeMessage({
				channelType: String(ChannelType.GROUP),
				mentionContext: { isMention: true, isReply: false },
			}),
		);

		expect(turnContent).toContain(FULL_TEMPLATE_MARKER);
		// Full context catalog with complete descriptions.
		expect(turnContent).toContain(
			"Support tickets: open, escalate, check status",
		);
		expect(FIXTURE_CONTEXTS[1].description).toBe(LONG_CONTEXT_DESCRIPTION);
		expect(turnContent).not.toContain("## Response Handler Fields");
	});

	it("renders the full rule block on a platform reply to the agent", async () => {
		const { turnContent } = await renderedStage1Prompt(
			makeMessage({
				channelType: String(ChannelType.GROUP),
				mentionContext: { isMention: false, isReply: true },
			}),
		);
		expect(turnContent).toContain(FULL_TEMPLATE_MARKER);
	});

	it("renders the full rule block when the agent is named in the text", async () => {
		const { turnContent } = await renderedStage1Prompt(
			makeMessage({
				channelType: String(ChannelType.GROUP),
				text: "Test Agent can you check the build?",
			}),
		);
		expect(turnContent).toContain(FULL_TEMPLATE_MARKER);
		expect(turnContent).toContain(
			"Sticky notes: create, read, update, delete, search",
		);
		expect(turnContent).not.toContain(
			candidateActionNamesFieldEvaluator.description,
		);
	});

	it.each([
		"agent whats the setting we use to make u always respond",
		"test the build before release",
	])("keeps generic multi-word-name tokens ambient: %s", (text) => {
		const message = makeMessage({
			channelType: String(ChannelType.GROUP),
			text,
		});
		const addressed = textContainsAgentName(text, ["Test Agent"]);
		expect(addressed).toBe(false);
		expect(isUnaddressedTextGroupTurn(message, addressed)).toBe(true);
	});

	it("preserves full names, explicit aliases, and distinctive name tokens", () => {
		expect(textContainsAgentName("Test Agent check this", ["Test Agent"])).toBe(
			true,
		);
		expect(
			textContainsAgentName("@test_agent check this", ["test_agent"]),
		).toBe(true);
		expect(
			textContainsAgentName("nubilio whats the setting", ["remilio nubilio"]),
		).toBe(true);
	});

	it.each([
		["Eliza, what time is it?", true],
		["hey Eliza can you help", true],
		["@Eliza why did that fail", true],
		["Eliza tell me about the weather", true],
		["Eliza help me with this", true],
		["Eliza show me the logs", true],
		["Eliza summarize that", true],
		["Eliza run the build", true],
		["ok Eliza", true],
		["I think Eliza is great", false],
		["Eliza was right about that", false],
		["ask Eliza about it", false],
	] as const)("classifies textual address %s -> %s", (text, expected) => {
		const runtime = { character: { name: "Eliza" } } as IAgentRuntime;
		const message = makeMessage({
			channelType: String(ChannelType.GROUP),
			text,
		});
		expect(classifyMessageAddress(runtime, message).textualAgentName).toBe(
			expected,
		);
	});

	it("renders the full rule block when channel type is missing (fail-open)", async () => {
		const { turnContent } = await renderedStage1Prompt(makeMessage());
		expect(turnContent).toContain(FULL_TEMPLATE_MARKER);
	});

	it("keeps the full canonical template on DM channels", async () => {
		const { turnContent, runtime } = await renderedStage1Prompt(
			makeMessage({ channelType: String(ChannelType.DM) }),
		);
		expect(turnContent).toContain(FULL_TEMPLATE_MARKER);
		expect(turnContent).toContain(
			"Support tickets: open, escalate, check status",
		);
		expect(FIXTURE_CONTEXTS[1].description).toBe(LONG_CONTEXT_DESCRIPTION);
		expect(turnContent).not.toContain("## Response Handler Fields");
		expect(
			JSON.stringify(
				(runtime.useModel as { mock: { calls: unknown[][] } }).mock.calls[0][1],
			),
		).toContain(candidateActionNamesFieldEvaluator.schema.description);
	});

	it("ignores the retired compact-tier setting and renders the full rule block", async () => {
		const { turnContent } = await renderedStage1Prompt(
			makeMessage({ channelType: String(ChannelType.GROUP) }),
			stage1Response({ shouldRespond: "IGNORE" }),
			{ ELIZA_STAGE1_GROUP_TRIAGE: "0" },
		);
		expect(turnContent).toContain(FULL_TEMPLATE_MARKER);
	});

	it("keeps addressed and unaddressed group instruction footprints identical", async () => {
		const unaddressed = await renderedStage1Prompt(
			makeMessage({ channelType: String(ChannelType.GROUP) }),
		);
		const addressed = await renderedStage1Prompt(
			makeMessage({
				channelType: String(ChannelType.GROUP),
				mentionContext: { isMention: true, isReply: false },
			}),
		);

		expect(unaddressed.systemContent).toBe(addressed.systemContent);
		expect(unaddressed.turnContent).toContain("ambient_turn_policy:");
		expect(addressed.turnContent).not.toContain("ambient_turn_policy:");
		const taskBlock = (content: string) =>
			content
				.slice(content.indexOf(FULL_TEMPLATE_MARKER))
				.split("# Conversation")[0];
		expect(taskBlock(unaddressed.turnContent)).toBe(
			taskBlock(addressed.turnContent),
		);
	});
});

describe("isUnaddressedTextGroupTurn structural edges", () => {
	it("rejects always-respond sources matched case-insensitively as substrings", () => {
		expect(
			isUnaddressedTextGroupTurn(
				makeMessage({
					channelType: String(ChannelType.GROUP),
					source: "Trigger-Prompt",
				}),
				false,
			),
		).toBe(false);
		expect(
			isUnaddressedTextGroupTurn(
				makeMessage({
					channelType: String(ChannelType.GROUP),
					source: "webhook-client_chat-bridge",
				}),
				false,
			),
		).toBe(false);
	});

	it("ignores non-true autonomous and sub-agent flags", () => {
		expect(
			isUnaddressedTextGroupTurn(
				makeMessage({
					channelType: String(ChannelType.GROUP),
					contentMetadata: { isAutonomous: false, subAgent: false },
				}),
				false,
			),
		).toBe(true);
	});

	it("treats array and null content metadata as absent", () => {
		const base = makeMessage({ channelType: String(ChannelType.GROUP) });
		expect(
			isUnaddressedTextGroupTurn(
				{ ...base, content: { ...base.content, metadata: [] } },
				false,
			),
		).toBe(true);
		expect(
			isUnaddressedTextGroupTurn(
				{ ...base, content: { ...base.content, metadata: null } },
				false,
			),
		).toBe(true);
	});

	it("classifies a group turn that carries no source field", () => {
		const base = makeMessage({ channelType: String(ChannelType.GROUP) });
		const { source: _discardedSource, ...contentWithoutSource } = base.content;
		expect(
			isUnaddressedTextGroupTurn(
				{ ...base, content: contentWithoutSource },
				false,
			),
		).toBe(true);
	});
});
