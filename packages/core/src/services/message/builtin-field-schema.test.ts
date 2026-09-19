/** Pins channel-scoped schema compaction against the real registry and pipeline. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHOULD_RESPOND_SCHEMA_DESCRIPTION } from "../../actions/to-tool";
import * as builtins from "../../runtime/builtin-field-evaluators";
import type { ResponseHandlerFieldEvaluator } from "../../runtime/response-handler-field-evaluator";
import { ResponseHandlerFieldRegistry } from "../../runtime/response-handler-field-registry";
import type { Memory } from "../../types/memory";
import type { JSONSchema } from "../../types/model";
import { ChannelType, type UUID } from "../../types/primitives";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { runV5MessageRuntimeStage1 } from "../message";
import { withInactiveArrayFields } from "./inactive-field-schema";

const removed = [
	"shouldRespond",
	"contexts",
	"intents",
	"candidateActionNames",
	"relationships",
	"topics",
	"addressedTo",
	"emotion",
];
const shortened = {
	replyText: "Plain text unless channel supports markdown.",
	facts: "One plain-English fact per item.",
};

function registry(custom?: ResponseHandlerFieldEvaluator) {
	const result = new ResponseHandlerFieldRegistry();
	if (custom) result.register(custom);
	for (const field of builtins.BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS)
		result.register(field);
	return result;
}

function properties(schema: JSONSchema): Record<string, JSONSchema> {
	if (!schema.properties) throw new Error("Expected object schema");
	return schema.properties;
}

function expectedCompact(schema: JSONSchema) {
	const result = structuredClone(schema);
	for (const name of removed) delete properties(result)[name].description;
	for (const [name, description] of Object.entries(shortened))
		properties(result)[name].description = description;
	return result;
}

function response(contextRequests: string[] = []) {
	return {
		text: "",
		toolCalls: [
			{
				id: "handler",
				name: "HANDLE_RESPONSE",
				arguments: {
					shouldRespond: "RESPOND",
					contexts: ["simple"],
					intents: [],
					candidateActionNames: [],
					contextRequests,
					replyText: contextRequests.length ? "" : "Hello.",
					replyEffectStatus: "none",
					facts: [],
					relationships: [],
					topics: [],
					addressedTo: [],
					emotion: "none",
				},
			},
		],
	};
}

function fixture(
	channelType: ChannelType,
	read = false,
	custom?: ResponseHandlerFieldEvaluator,
) {
	const state: State = {
		values: { availableContexts: "general" },
		data: {},
		text: "",
	};
	if (read)
		state.data.providers = {
			WIDGETS: {
				text: "The complete authorized widget reference.",
				discoveryText: "context_discovery: WIDGETS",
			},
		};
	const responses = read ? [response(["WIDGETS"]), response()] : [response()];
	const fields = registry(custom);
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000003" as UUID,
		character: {
			name: "Test Agent",
			system: "You are concise.",
			bio: "You help.",
		},
		actions: [],
		providers: read ? [{ name: "WIDGETS", get: vi.fn() }] : [],
		getService: vi.fn(() => null),
		getRoom: vi.fn(async () => null),
		getModelRegistrations: vi.fn(() => []),
		composeState: vi.fn(async () => structuredClone(state)),
		runActionsByMode: vi.fn(async () => undefined),
		emitEvent: vi.fn(async () => undefined),
		reportError: vi.fn(),
		getSetting: vi.fn(),
		useModel: vi.fn(async () => {
			const next = responses.shift();
			if (!next) throw new Error("Unexpected model call");
			return next;
		}),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
		responseHandlerFieldRegistry: fields,
		responseHandlerFieldEvaluators: fields.list(),
		responseHandlerEvaluators: [],
	} as unknown as IAgentRuntime;
	const message: Memory = {
		id: "00000000-0000-0000-0000-000000000001" as UUID,
		entityId: "00000000-0000-0000-0000-000000000002" as UUID,
		agentId: runtime.agentId,
		roomId: "00000000-0000-0000-0000-000000000004" as UUID,
		content: { text: "Hello", source: "test", channelType },
		createdAt: 1,
	};
	return {
		runtime,
		state,
		message,
		responseId: message.id as UUID,
		stage1DecisionOnly: true,
	};
}

function requestSchemas(runtime: IAgentRuntime): JSONSchema[] {
	return vi.mocked(runtime.useModel).mock.calls.map(([, params]) => {
		const request = params as {
			tools: Array<{ name: string; parameters: JSONSchema }>;
		};
		const tool = request.tools.find((tool) => tool.name === "HANDLE_RESPONSE");
		if (!tool) throw new Error("Missing HANDLE_RESPONSE");
		return tool.parameters;
	});
}

afterEach(() => vi.restoreAllMocks());

describe("direct-text builtin schema descriptions", () => {
	it("changes only the ten root descriptions, leaving canonical schemas and nested validation untouched", () => {
		const fields = registry();
		const original = fields.composeSchema();
		const snapshot = structuredClone(original);
		const projected = builtins.withDirectTextBuiltinSchemaDescriptions(
			original,
			fields.list(),
		);
		expect(projected).toEqual(expectedCompact(original));
		expect(original).toEqual(snapshot);
		expect(fields.composeSchema()).toBe(original);
		expect(properties(original).shouldRespond.description).toBe(
			SHOULD_RESPOND_SCHEMA_DESCRIPTION,
		);
		for (const name of [...removed, ...Object.keys(shortened)])
			expect(properties(original)[name].description).toBeTruthy();
		expect(properties(projected).relationships.items).toBe(
			properties(original).relationships.items,
		);
		expect(projected.required).toBe(original.required);
		expect(properties(projected).completionContext).toBe(
			properties(original).completionContext,
		);
		const inactive = withInactiveArrayFields(projected, ["relationships"]);
		expect(properties(inactive).relationships.enum).toEqual([[]]);
		expect(properties(inactive).shouldRespond.description).toBeUndefined();
		expect(properties(projected).relationships.items).toBe(
			properties(original).relationships.items,
		);
	});

	it("preserves custom same-name registrations and separately replaced schema slices", () => {
		const custom = {
			...builtins.shouldRespondFieldEvaluator,
			description: "Custom response policy.",
			schema: {
				...builtins.shouldRespondFieldEvaluator.schema,
				description: "Custom schema policy.",
			},
		};
		const fields = registry(custom);
		const original = fields.composeSchema();
		const projected = builtins.withDirectTextBuiltinSchemaDescriptions(
			original,
			fields.list(),
		);
		expect(properties(projected).shouldRespond).toBe(custom.schema);
		expect(properties(projected).contexts.description).toBeUndefined();
		const replaced = {
			...original,
			properties: {
				shouldRespond: { ...builtins.shouldRespondFieldEvaluator.schema },
			},
		};
		expect(
			builtins.withDirectTextBuiltinSchemaDescriptions(replaced, [
				builtins.shouldRespondFieldEvaluator,
			]),
		).toBe(replaced);
	});

	it.each([ChannelType.DM, ChannelType.GROUP, ChannelType.VOICE_DM])(
		"uses the correct schema in the production %s pipeline",
		async (channelType) => {
			const args = fixture(channelType);
			const canonical =
				args.runtime.responseHandlerFieldRegistry.composeSchema();
			const before = structuredClone(canonical);
			await runV5MessageRuntimeStage1(args);
			const [schema] = requestSchemas(args.runtime);
			expect(schema).toBeDefined();
			const expected =
				channelType === ChannelType.DM ? expectedCompact(canonical) : canonical;
			for (const name of [...removed, ...Object.keys(shortened)])
				expect(properties(schema)[name]).toEqual(properties(expected)[name]);
			expect(canonical).toEqual(before);
		},
	);

	it("keeps compact builtin descriptions on context-read continuation while retaining custom fields", async () => {
		const custom = {
			...builtins.factsFieldEvaluator,
			description: "Custom facts guidance.",
			schema: {
				...builtins.factsFieldEvaluator.schema,
				description: "Custom facts contract.",
			},
		};
		const args = fixture(ChannelType.DM, true, custom);
		const result = await runV5MessageRuntimeStage1(args);
		const schemas = requestSchemas(args.runtime);
		expect(schemas).toHaveLength(2);
		for (const schema of schemas) {
			expect(properties(schema).shouldRespond.description).toBeUndefined();
			expect(properties(schema).replyText.description).toBe(
				shortened.replyText,
			);
			expect(properties(schema).facts).toEqual(custom.schema);
		}
		expect(result.kind).toBe("decision");
	});

	it("does not project or call a model on the trusted coding path", async () => {
		const projection = vi.spyOn(
			builtins,
			"withDirectTextBuiltinSchemaDescriptions",
		);
		const args = fixture(ChannelType.DM);
		await runV5MessageRuntimeStage1({ ...args, codingMode: true });
		expect(projection).not.toHaveBeenCalled();
		expect(args.runtime.useModel).not.toHaveBeenCalled();
		expect(
			properties(args.runtime.responseHandlerFieldRegistry.composeSchema())
				.shouldRespond.description,
		).toBe(SHOULD_RESPOND_SCHEMA_DESCRIPTION);
	});
});
