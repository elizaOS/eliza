/**
 * The planner pass must NOT stream its internals (raw reasoning, the forced
 * PLAN_ACTIONS envelope) to the chat SSE callback — only the structured
 * RESPONSE_HANDLER reply streams token-by-token. callPlanner enforces this by
 * running its `useModel` call inside a streaming context whose `onStreamChunk`
 * is a no-op (`planner-loop.ts`), shadowing the message handler's chat-SSE sink.
 *
 * Removing that override would silently leak planner internals into the user's
 * token stream AND pass every other test — so this guards it directly. The
 * positive control proves the negative assertion is not vacuous.
 */
import { describe, expect, it, vi } from "vitest";
import {
	getStreamingContext,
	runWithStreamingContext,
} from "../../streaming-context";
import { runPlannerLoop } from "../planner-loop";

describe("planner streaming suppression", () => {
	it("swallows the planner model's stream chunks so they never reach the chat SSE sink", async () => {
		const chatSseSink = vi.fn();

		const runtime = {
			// Simulate a STREAMING planner model: it pushes a chunk into whatever
			// streaming context is active during the call. With the no-op override
			// in place this hits the dead callback; without it (regression), it
			// would reach chatSseSink.
			useModel: vi.fn(async () => {
				const active = getStreamingContext();
				await active?.onStreamChunk?.(
					"PLANNER_INTERNAL_LEAK",
					undefined,
					"PLANNER_INTERNAL_LEAK",
				);
				return {
					text: JSON.stringify({
						thought: "done",
						toolCalls: [],
						messageToUser: "ok",
					}),
				};
			}),
		};

		await runWithStreamingContext(
			{
				messageId: "msg-1",
				onStreamChunk: async (chunk: string) => {
					chatSseSink(chunk);
				},
			} as never,
			() =>
				runPlannerLoop({
					runtime: runtime as never,
					context: { id: "ctx", events: [] } as never,
					executeToolCall: vi.fn(),
					evaluate: vi.fn(),
				}),
		);

		// The planner model ran inside the active streaming context...
		expect(runtime.useModel).toHaveBeenCalled();
		// ...but its streamed chunk was swallowed by the no-op override — it must
		// NOT have reached the chat SSE sink.
		expect(chatSseSink).not.toHaveBeenCalled();
	});

	it("positive control: the same emission DOES reach the sink without a suppression layer", async () => {
		const sink = vi.fn();
		await runWithStreamingContext(
			{
				messageId: "m",
				onStreamChunk: async (chunk: string) => {
					sink(chunk);
				},
			} as never,
			async () => {
				const active = getStreamingContext();
				await active?.onStreamChunk?.("VISIBLE", undefined, "VISIBLE");
			},
		);
		expect(sink).toHaveBeenCalledWith("VISIBLE");
	});
});
