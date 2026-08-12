/**
 * Deterministic MESSAGE draft coverage spans structured extraction and the real
 * action-result boundary into planner terminal authority; no live model runs.
 */
import { describe, expect, it, vi } from "vitest";
import {
	actionResultToPlannerToolResult,
	runPlannerLoop,
} from "../../../../runtime/planner-loop.ts";
import type {
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
} from "../../../../types/index.ts";
import {
	outboundDraftOptionsFromMessage,
	sendDraftAction,
} from "./sendDraft.ts";

/**
 * #10470: the `MESSAGE` action extracts the outbound platform/recipient/body via
 * the model's structured output instead of English-only regex. These tests cover
 * the WIRING — that the model is invoked only when the structured params are
 * incomplete, its output is parsed into the draft, and a model failure degrades
 * gracefully. The model's extraction QUALITY (incl. non-English) is proven by the
 * live-model trajectory in
 * `test-results/evidence/10470-llm-driven-actions/sendDraft-extraction.md`,
 * not by these stubs.
 */
function msg(text: string): Memory {
	return { content: { text } } as Memory;
}
function params(p: Record<string, unknown>): HandlerOptions {
	return { parameters: p } as HandlerOptions;
}

describe("sendDraft outboundDraftOptionsFromMessage — structured extraction wiring (#10470)", () => {
	it("invokes the model to fill missing fields and parses its structured output", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValue(
				"<source>whatsapp</source>\n<recipient>Ana</recipient>\n<body>llego en 5 minutos</body>",
			);
		const runtime = { useModel } as unknown as IAgentRuntime;

		const out = await outboundDraftOptionsFromMessage(
			runtime,
			msg("envíale a Ana un WhatsApp diciendo que llego en 5 minutos"),
			undefined,
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(out?.parameters).toMatchObject({
			source: "whatsapp",
			body: "llego en 5 minutos",
			to: ["Ana"],
		});
	});

	it("does NOT call the model when the structured params are already complete (cheap fast path)", async () => {
		const useModel = vi.fn().mockResolvedValue("<source>telegram</source>");
		const runtime = { useModel } as unknown as IAgentRuntime;

		const out = await outboundDraftOptionsFromMessage(
			runtime,
			msg("ignored — params already structured"),
			params({ source: "telegram", body: "hi", to: ["Bob"] }),
		);

		expect(useModel).not.toHaveBeenCalled();
		expect(out?.parameters).toMatchObject({
			source: "telegram",
			body: "hi",
			to: ["Bob"],
		});
	});

	it("still extracts when only SOME params are present (model fills the gaps)", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValue(
				"<source>telegram</source>\n<recipient>Bob</recipient>\n<body>running late</body>",
			);
		const runtime = { useModel } as unknown as IAgentRuntime;

		// source provided, but recipient + body missing → model is consulted.
		const out = await outboundDraftOptionsFromMessage(
			runtime,
			msg("tell Bob I'm running late on telegram"),
			params({ source: "telegram" }),
		);

		expect(useModel).toHaveBeenCalledTimes(1);
		expect(out?.parameters).toMatchObject({
			source: "telegram",
			body: "running late",
			to: ["Bob"],
		});
	});

	it("surfaces a model failure instead of treating it as missing user input", async () => {
		const useModel = vi.fn().mockRejectedValue(new Error("model unavailable"));
		const runtime = { useModel } as unknown as IAgentRuntime;

		await expect(
			outboundDraftOptionsFromMessage(
				runtime,
				msg("send something to someone"),
				undefined,
			),
		).rejects.toThrow("model unavailable");

		expect(useModel).toHaveBeenCalledTimes(1);
	});

	it("relays missing-draft guidance exactly and stops the planner awaiting input", async () => {
		const guidance = "Could not create outbound draft: body is required.";
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "draft",
						name: "MESSAGE",
						arguments: { source: "telegram" },
					},
				],
			})
			.mockResolvedValueOnce(
				"<response><source>telegram</source><recipient></recipient><body></body></response>",
			);
		const runtime = { useModel } as unknown as IAgentRuntime;
		const callback = vi.fn(async () => []) as unknown as HandlerCallback;
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "The missing-input action owns the reply.",
			messageToUser: "GENERIC_FALLBACK",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			tools: [
				{
					name: "MESSAGE",
					description: "Create or send an outbound message draft.",
				},
			],
			executeToolCall: async (toolCall) => {
				const actionResult = await sendDraftAction.handler(
					runtime,
					msg("Send a Telegram message"),
					undefined,
					params(toolCall.params ?? {}),
					callback,
				);
				if (!actionResult) throw new Error("MESSAGE returned no action result");
				return actionResultToPlannerToolResult(actionResult);
			},
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(2);
		expect(evaluate).not.toHaveBeenCalled();
		expect(callback).toHaveBeenCalledExactlyOnceWith({
			text: guidance,
			action: "MESSAGE",
		});
		expect(result.finalMessage).toBe(guidance);
		expect(result.finalMessage).not.toBe("GENERIC_FALLBACK");
		expect(result.trajectory.steps[0]?.result).toMatchObject({
			success: false,
			continueChain: false,
			userFacingText: guidance,
			verifiedUserFacing: true,
			data: {
				actionName: "MESSAGE",
				error: "MISSING_DRAFT_DETAILS",
				awaitingUserInput: true,
			},
		});
		expect(result.trajectory.steps.at(-1)?.terminalMessage).toBe(guidance);
	});
});
