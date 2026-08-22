/**
 * An action's *internal* `runtime.useModel` calls must NOT stream into the
 * turn's visible reply channel (#16230). The visible token stream is scoped to
 * the top-level RESPONSE_HANDLER generation; an action delivers its own output
 * through the HandlerCallback, and any model call it makes to produce that
 * output is an
 * implementation detail the user must never see. `executePlannedToolCall`
 * enforces this through the handler-settlement boundary, which keeps both the
 * handler and its deferred callback delivery inside
 * `runWithSuppressedModelStream`. The scope shadows chat-SSE `onStreamChunk`
 * with a no-op while keeping the abort signal and structured hooks.
 *
 * The positive controls prove the negative assertions are not vacuous: the same
 * emission DOES reach the sink when it happens at the top level (outside the
 * suppression seam).
 */
import { describe, expect, it, vi } from "vitest";
import { wrapSingleTurnVisibleCallback } from "../../services/message";
import {
	getStreamingContext,
	runWithStreamingContext,
	runWithSuppressedModelStream,
} from "../../streaming-context";
import type { Action, IAgentRuntime, Memory } from "../../types";
import { ModelType } from "../../types/model";
import { executePlannedToolCall } from "../execute-planned-tool-call";

const LEDGER_JSON = '```json\n{ "state": { "facts": ["internal fact"] } }\n```';
const CLEAN_SUMMARY = "Inspection completed.";
const VOICE_REWRITE_JSON = '```json\n{"response":"opened notes."}\n```';

function makeMessage(): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text: "/inspect" },
	} as Memory;
}

/**
 * An action that makes an internal TEXT_LARGE
 * call whose stubbed handler streams intermediate ledger JSON into whatever
 * streaming context is active, then delivers its designed reply through the
 * HandlerCallback.
 */
function makeModelUsingAction(): Action {
	return {
		name: "INSPECT",
		description: "Inspect runtime state",
		validate: async () => true,
		handler: async (runtime, _message, _state, _options, callback) => {
			// Internal model call: streaming happens inside useModel, which reads
			// the ambient streaming context. This is the leak vector.
			await runtime.useModel(ModelType.TEXT_LARGE, {
				prompt: "extract the conversation ledger",
			});
			// The action's actual, user-visible reply.
			await callback?.({ text: CLEAN_SUMMARY });
			return { success: true, text: CLEAN_SUMMARY };
		},
	} as Action;
}

function makeRuntime(action: Action): IAgentRuntime {
	return {
		actions: [action],
		getRoom: vi.fn(async () => null),
		logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		// A STREAMING TEXT_LARGE model: it pushes the intermediate ledger into
		// whatever streaming context is active during the call.
		useModel: vi.fn(async () => {
			const active = getStreamingContext();
			await active?.onStreamChunk?.(LEDGER_JSON, undefined, LEDGER_JSON);
			return LEDGER_JSON;
		}),
	} as unknown as IAgentRuntime;
}

describe("action streaming suppression (#16230)", () => {
	it("keeps an action's internal useModel tokens off the visible reply stream, delivering only the callback reply", async () => {
		const visibleSink = vi.fn();
		const callbackReplies: string[] = [];
		const action = makeModelUsingAction();
		const runtime = makeRuntime(action);

		const result = await runWithStreamingContext(
			{
				messageId: "msg-1",
				onStreamChunk: async (chunk: string) => {
					visibleSink(chunk);
				},
			} as never,
			() =>
				executePlannedToolCall(
					runtime,
					{
						message: makeMessage(),
						callback: async (content) => {
							if (typeof content?.text === "string") {
								callbackReplies.push(content.text);
							}
							return [];
						},
					},
					{ name: "INSPECT", params: {} },
				),
		);

		// The internal model call ran inside the active streaming context...
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		// ...but its intermediate ledger JSON was swallowed by the suppression
		// seam — it must NEVER surface as a visible token.
		expect(visibleSink).not.toHaveBeenCalled();
		// The designed reply reaches the client through the HandlerCallback.
		expect(callbackReplies).toEqual([CLEAN_SUMMARY]);
		expect(result.success).toBe(true);
		expect(result.text).toBe(CLEAN_SUMMARY);
	});

	it("keeps a deferred action-callback voice rewrite off the visible stream while delivering its parsed text once", async () => {
		const visibleSink = vi.fn();
		const deliveredCallback = vi.fn(async () => []);
		const action = {
			name: "INSPECT_VIEW",
			description: "Inspect a view",
			validate: async () => true,
			handler: async (_runtime, _message, _state, _options, callback) => {
				await callback?.({ text: "Current view: Notes." }, "INSPECT_VIEW");
				return { success: true, text: "Current view: Notes." };
			},
		} as Action;
		const runtime = {
			...makeRuntime(action),
			agentId: "agent-id",
			character: { name: "Eliza", style: { all: ["warm", "concise"] } },
			useModel: vi.fn(async () => {
				const active = getStreamingContext();
				await active?.onStreamChunk?.(
					VOICE_REWRITE_JSON,
					undefined,
					VOICE_REWRITE_JSON,
				);
				return VOICE_REWRITE_JSON;
			}),
		} as unknown as IAgentRuntime;
		const message = makeMessage();
		const callback = wrapSingleTurnVisibleCallback(
			runtime,
			message,
			deliveredCallback,
		);

		await runWithStreamingContext(
			{
				messageId: "msg-deferred-callback",
				onStreamChunk: async (chunk: string) => {
					visibleSink(chunk);
				},
			} as never,
			() =>
				executePlannedToolCall(
					runtime,
					{ message, callback },
					{ name: "INSPECT_VIEW", params: {} },
				),
		);

		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		expect(visibleSink).not.toHaveBeenCalled();
		expect(deliveredCallback).toHaveBeenCalledTimes(1);
		expect(deliveredCallback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "opened notes.",
				data: expect.objectContaining({
					rawActionText: "Current view: Notes.",
					voiceRewritten: true,
				}),
			}),
			"INSPECT_VIEW",
		);
	});

	it("positive control: the same internal emission DOES reach the sink at the top level (outside the action seam)", async () => {
		const visibleSink = vi.fn();
		const runtime = makeRuntime(makeModelUsingAction());

		await runWithStreamingContext(
			{
				messageId: "msg-2",
				onStreamChunk: async (chunk: string) => {
					visibleSink(chunk);
				},
			} as never,
			// Calling the streaming model directly at the top level — the way the
			// RESPONSE_HANDLER reply generation does — is exactly what SHOULD stream.
			() => runtime.useModel(ModelType.TEXT_LARGE, { prompt: "reply" }),
		);

		expect(visibleSink).toHaveBeenCalledWith(LEDGER_JSON);
	});

	it("runWithSuppressedModelStream is a pass-through when no streaming context is active", async () => {
		const ran = vi.fn();
		await runWithSuppressedModelStream(async () => {
			expect(getStreamingContext()).toBeUndefined();
			ran();
		});
		expect(ran).toHaveBeenCalledTimes(1);
	});

	it("runWithSuppressedModelStream preserves the abort signal and structured hooks while detaching onStreamChunk", async () => {
		const abortSignal = new AbortController().signal;
		const onToolResult = vi.fn(async () => undefined);
		const visibleSink = vi.fn();

		await runWithStreamingContext(
			{
				messageId: "msg-3",
				abortSignal,
				onStreamChunk: async (chunk: string) => {
					visibleSink(chunk);
				},
				onToolResult,
			} as never,
			() =>
				runWithSuppressedModelStream(async () => {
					const inner = getStreamingContext();
					// onStreamChunk is detached...
					await inner?.onStreamChunk?.(LEDGER_JSON, undefined, LEDGER_JSON);
					// ...but the abort signal and structured hooks are intact.
					expect(inner?.abortSignal).toBe(abortSignal);
					expect(inner?.onToolResult).toBe(onToolResult);
				}),
		);

		expect(visibleSink).not.toHaveBeenCalled();
	});
});
