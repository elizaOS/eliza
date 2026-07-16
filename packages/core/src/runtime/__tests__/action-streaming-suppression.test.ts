/**
 * An action's *internal* `runtime.useModel` calls must NOT stream into the
 * turn's visible reply channel (#16230). The visible token stream is scoped to
 * the top-level RESPONSE_HANDLER generation; an action delivers its own output
 * through the HandlerCallback, and any model call it makes to produce that
 * output (e.g. the conversation compactor's ledger extraction) is an
 * implementation detail the user must never see. `executePlannedToolCall`
 * enforces this by running the handler inside `runWithSuppressedModelStream`,
 * which shadows the chat-SSE `onStreamChunk` with a no-op while keeping the
 * abort signal and structured hooks.
 *
 * The positive controls prove the negative assertions are not vacuous: the same
 * emission DOES reach the sink when it happens at the top level (outside the
 * suppression seam).
 */
import { describe, expect, it, vi } from "vitest";
import {
	getStreamingContext,
	runWithStreamingContext,
	runWithSuppressedModelStream,
} from "../../streaming-context";
import type { Action, IAgentRuntime, Memory } from "../../types";
import { ModelType } from "../../types/model";
import { executePlannedToolCall } from "../execute-planned-tool-call";

const LEDGER_JSON = '```json\n{ "state": { "facts": ["internal fact"] } }\n```';
const CLEAN_SUMMARY = "Compacted 8 older message(s); preserved the latest 4.";

function makeMessage(): Memory {
	return {
		id: "message-id",
		entityId: "entity-id",
		roomId: "room-id",
		content: { text: "/compact" },
	} as Memory;
}

/**
 * An action that mirrors COMPACT_CONVERSATION: it makes an internal TEXT_LARGE
 * call whose stubbed handler streams intermediate ledger JSON into whatever
 * streaming context is active, then delivers its designed reply through the
 * HandlerCallback.
 */
function makeCompactorLikeAction(): Action {
	return {
		name: "COMPACT_CONVERSATION",
		description: "Compact the conversation",
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
		const action = makeCompactorLikeAction();
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
					{ name: "COMPACT_CONVERSATION", params: {} },
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

	it("positive control: the same internal emission DOES reach the sink at the top level (outside the action seam)", async () => {
		const visibleSink = vi.fn();
		const runtime = makeRuntime(makeCompactorLikeAction());

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
