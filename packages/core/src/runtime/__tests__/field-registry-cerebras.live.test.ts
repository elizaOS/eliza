/**
 * Live Cerebras smoke test for the ResponseHandlerFieldRegistry substrate.
 *
 * Runs against `gpt-oss-120b` at https://api.cerebras.ai/v1 — the same
 * provider used in production for low-latency Stage-1 calls. Skipped unless
 * both `CEREBRAS_API_KEY` is set AND `ELIZA_RUN_LIVE_TESTS=1`.
 *
 * What this proves:
 *   1. The composed schema (built from `BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS`
 *      + the threadOps-style plugin field shape) is acceptable to Cerebras's
 *      OpenAI-compatible structured-output endpoint.
 *   2. The system + user prompt slices, assembled from each evaluator's
 *      `description`, produce coherent extraction.
 *   3. The dispatch path (parse + handle) round-trips the LLM response
 *      cleanly into a typed `ResponseHandlerResult` with all required fields.
 *   4. Per-field handlers (in this test: a minimal `threadOps`-like handler)
 *      run on the parsed slice and can emit a `preempt`.
 *
 * This is the canonical end-to-end validation that the new substrate works
 * against a real LLM. It does NOT spin up a full AgentRuntime — that's
 * orthogonal to the substrate.
 */

import { describe, expect, it } from "vitest";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import type { State } from "../../types/state";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../builtin-field-evaluators";
import type {
	ResponseHandlerFieldContext,
	ResponseHandlerFieldEffect,
	ResponseHandlerFieldEvaluator,
	ResponseHandlerFieldHandleContext,
} from "../response-handler-field-evaluator";
import { ResponseHandlerFieldRegistry } from "../response-handler-field-registry";

const cerebrasKey = process.env.CEREBRAS_API_KEY?.trim();
const runLive =
	(process.env.ELIZA_RUN_LIVE_TESTS ?? "").trim() === "1" && !!cerebrasKey;
const liveDescribe = runLive ? describe : describe.skip;

const CEREBRAS_URL = "https://api.cerebras.ai/v1/chat/completions";
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL?.trim() || "gpt-oss-120b";

interface CerebrasChatRequest {
	model: string;
	messages: Array<{ role: string; content: string }>;
	tools: Array<{
		type: "function";
		function: {
			name: string;
			description: string;
			parameters: unknown;
			strict?: boolean;
		};
	}>;
	tool_choice?:
		| "auto"
		| { type: "function"; function: { name: string } };
	temperature?: number;
	max_completion_tokens?: number;
}

interface CerebrasChatResponse {
	choices: Array<{
		message: {
			role: string;
			content?: string | null;
			tool_calls?: Array<{
				id: string;
				type: "function";
				function: { name: string; arguments: string };
			}>;
		};
		finish_reason: string;
	}>;
	usage?: { prompt_tokens: number; completion_tokens: number };
}

async function callCerebras(
	request: CerebrasChatRequest,
): Promise<CerebrasChatResponse> {
	const response = await fetch(CEREBRAS_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${cerebrasKey}`,
		},
		body: JSON.stringify(request),
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		const body = await response.text();
		throw new Error(
			`Cerebras request failed (${response.status} ${response.statusText}): ${body}`,
		);
	}
	return (await response.json()) as CerebrasChatResponse;
}

// Minimal IAgentRuntime fake — only the surfaces our handlers touch.
function buildFakeRuntime(): IAgentRuntime {
	return {
		agentId: "test-agent" as `${string}-${string}-${string}-${string}-${string}`,
		logger: {
			debug: () => {},
			info: () => {},
			warn: () => {},
			error: () => {},
		},
		turnControllers: {
			abortTurn: () => false,
			hasActiveTurn: () => false,
		},
	} as unknown as IAgentRuntime;
}

function buildMessage(text: string, roomId = "room-test"): Memory {
	return {
		id: "msg-1" as `${string}-${string}-${string}-${string}-${string}`,
		roomId: roomId as `${string}-${string}-${string}-${string}-${string}`,
		entityId: "alice" as `${string}-${string}-${string}-${string}-${string}`,
		content: { text },
		createdAt: Date.now(),
	} as Memory;
}

function buildState(): State {
	return { values: {}, data: {}, text: "" };
}

/**
 * Minimal abort-capable plugin field, modeled on the real `threadOps`
 * evaluator. We use a stripped-down version here so this test does not
 * depend on plugin code.
 */
const testAbortField: ResponseHandlerFieldEvaluator<
	Array<{ type: string; reason?: string }>
> = {
	name: "threadOps",
	priority: 30,
	description:
		'Thread operations. If the user clearly asks to stop, cancel, or abort the agent\'s current work, emit [{"type":"abort","reason":"<short why>"}]. Otherwise emit [].',
	schema: {
		type: "array",
		items: {
			type: "object",
			additionalProperties: false,
			properties: {
				type: { type: "string", enum: ["abort"] },
				reason: { type: ["string", "null"] },
			},
			required: ["type", "reason"],
		},
	},
	parse(value) {
		if (!Array.isArray(value)) return [];
		return value
			.filter((v) => v && typeof v === "object" && (v as { type?: unknown }).type === "abort")
			.map((v) => {
				const r = v as { reason?: unknown };
				return {
					type: "abort",
					reason: typeof r.reason === "string" ? r.reason : undefined,
				};
			});
	},
	handle(ctx: ResponseHandlerFieldHandleContext<Array<{ type: string; reason?: string }>>):
		| ResponseHandlerFieldEffect
		| undefined {
		if (ctx.value.length === 0) return undefined;
		return {
			preempt: { mode: "ack-and-stop", reason: ctx.value[0]?.reason ?? "abort" },
			debug: [`abort: ${ctx.value[0]?.reason ?? "unknown"}`],
		};
	},
};

function buildSystemPrompt(promptSlices: string): string {
	return [
		"You are a structured-output assistant. You will be given an inbound user message.",
		"Use the HANDLE_RESPONSE tool to emit a single structured response.",
		"Every field is REQUIRED. Use the field's empty value when not applicable.",
		"",
		"## Available contexts",
		"general, code, simple",
		"",
		"## Field instructions",
		promptSlices,
	].join("\n");
}

liveDescribe("ResponseHandlerFieldRegistry — live Cerebras smoke", () => {
	it("composes a stable schema and round-trips through gpt-oss-120b", async () => {
		const registry = new ResponseHandlerFieldRegistry();
		for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
			registry.register(evaluator);
		}
		registry.register(testAbortField);

		const composedSchema = registry.composeSchema();
		expect(composedSchema.type).toBe("object");
		expect(composedSchema.additionalProperties).toBe(false);
		const required = (composedSchema as { required?: string[] }).required ?? [];
		for (const fieldName of [
			"shouldRespond",
			"contexts",
			"intents",
			"replyText",
			"candidateActionNames",
			"facts",
			"relationships",
			"addressedTo",
			"threadOps",
		]) {
			expect(required).toContain(fieldName);
		}

		const ctx: ResponseHandlerFieldContext = {
			runtime: buildFakeRuntime(),
			message: buildMessage("hi, can you help me set a reminder for 5pm to call mom"),
			state: buildState(),
			senderRole: "OWNER",
			turnSignal: new AbortController().signal,
		};
		const slices = await registry.composePromptSlices(ctx);

		const tool = {
			type: "function" as const,
			function: {
				name: "HANDLE_RESPONSE",
				description: "Emit the structured response for this turn.",
				parameters: composedSchema as unknown,
				strict: true,
			},
		};

		const request: CerebrasChatRequest = {
			model: CEREBRAS_MODEL,
			messages: [
				{ role: "system", content: buildSystemPrompt(slices.rendered) },
				{
					role: "user",
					content: `Inbound message: "${ctx.message.content?.text ?? ""}"\n\nReply via the HANDLE_RESPONSE tool. All fields required.`,
				},
			],
			tools: [tool],
			tool_choice: { type: "function", function: { name: "HANDLE_RESPONSE" } },
			temperature: 0,
			max_completion_tokens: 2048,
		};

		const response = await callCerebras(request);
		expect(response.choices?.[0]).toBeDefined();
		const toolCall = response.choices[0].message.tool_calls?.[0];
		expect(toolCall?.function?.name).toBe("HANDLE_RESPONSE");
		const rawArgs = toolCall?.function.arguments ?? "{}";
		const rawParsed = JSON.parse(rawArgs) as Record<string, unknown>;

		// Sanity: all required fields should be present (Cerebras strict mode).
		for (const fieldName of required) {
			expect(rawParsed).toHaveProperty(fieldName);
		}

		const dispatchResult = await registry.dispatch({
			rawParsed,
			runtime: ctx.runtime,
			message: ctx.message,
			state: ctx.state,
			senderRole: ctx.senderRole,
			turnSignal: ctx.turnSignal,
		});

		// The simple "set a reminder for 5pm to call mom" prompt should NOT
		// trigger abort (no retraction language).
		expect(dispatchResult.preempt).toBeUndefined();

		// shouldRespond should be RESPOND for a direct request.
		expect(dispatchResult.parsed.shouldRespond).toBe("RESPOND");

		// At least one of: contexts, intents, candidateActionNames should be
		// non-empty (the model engages SOME extraction surface).
		const engaged =
			dispatchResult.parsed.contexts.length +
			dispatchResult.parsed.intents.length +
			dispatchResult.parsed.candidateActionNames.length;
		expect(engaged).toBeGreaterThan(0);

		// Trace shape: every evaluator should have a trace row.
		expect(dispatchResult.traces.length).toBe(registry.size());

		console.log(
			"[field-registry-cerebras] usage:",
			response.usage,
			"\n[field-registry-cerebras] parsed.shouldRespond:",
			dispatchResult.parsed.shouldRespond,
			"\n[field-registry-cerebras] parsed.contexts:",
			dispatchResult.parsed.contexts,
			"\n[field-registry-cerebras] parsed.intents:",
			dispatchResult.parsed.intents,
			"\n[field-registry-cerebras] parsed.candidateActionNames:",
			dispatchResult.parsed.candidateActionNames,
			"\n[field-registry-cerebras] parsed.replyText:",
			dispatchResult.parsed.replyText,
			"\n[field-registry-cerebras] traces:",
			dispatchResult.traces.map((t) => ({
				field: t.fieldName,
				active: t.active,
				outcome: t.parseOutcome,
				handled: t.handled,
			})),
		);
	}, 60_000);

	it("extracts an abort intent when the user retracts mid-task", async () => {
		const registry = new ResponseHandlerFieldRegistry();
		for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
			registry.register(evaluator);
		}
		registry.register(testAbortField);

		const composedSchema = registry.composeSchema();
		const ctx: ResponseHandlerFieldContext = {
			runtime: buildFakeRuntime(),
			message: buildMessage(
				"wait actually nevermind, stop what you're doing. don't send that email.",
			),
			state: buildState(),
			senderRole: "OWNER",
			turnSignal: new AbortController().signal,
		};
		const slices = await registry.composePromptSlices(ctx);

		const tool = {
			type: "function" as const,
			function: {
				name: "HANDLE_RESPONSE",
				description: "Emit the structured response for this turn.",
				parameters: composedSchema as unknown,
				strict: true,
			},
		};

		const request: CerebrasChatRequest = {
			model: CEREBRAS_MODEL,
			messages: [
				{
					role: "system",
					content: buildSystemPrompt(
						`${slices.rendered}\n\nContext: the agent was working on drafting and sending an email. The user is now retracting that request.`,
					),
				},
				{
					role: "user",
					content: `Inbound message: "${ctx.message.content?.text ?? ""}"\n\nReply via the HANDLE_RESPONSE tool. All fields required.`,
				},
			],
			tools: [tool],
			tool_choice: { type: "function", function: { name: "HANDLE_RESPONSE" } },
			temperature: 0,
			max_completion_tokens: 2048,
		};

		const response = await callCerebras(request);
		const toolCall = response.choices[0].message.tool_calls?.[0];
		const rawArgs = toolCall?.function.arguments ?? "{}";
		const rawParsed = JSON.parse(rawArgs) as Record<string, unknown>;

		const dispatchResult = await registry.dispatch({
			rawParsed,
			runtime: ctx.runtime,
			message: ctx.message,
			state: ctx.state,
			senderRole: ctx.senderRole,
			turnSignal: ctx.turnSignal,
		});

		// The model should emit at least one abort op given the retraction.
		const threadOpsValue = dispatchResult.parsed.threadOps as Array<{
			type: string;
		}> | undefined;
		const abortOps = Array.isArray(threadOpsValue)
			? threadOpsValue.filter((op) => op?.type === "abort")
			: [];

		console.log(
			"[field-registry-cerebras] abort-test parsed:",
			JSON.stringify(rawParsed, null, 2),
		);

		expect(abortOps.length).toBeGreaterThan(0);
		expect(dispatchResult.preempt?.mode).toBe("ack-and-stop");
	}, 60_000);
});
