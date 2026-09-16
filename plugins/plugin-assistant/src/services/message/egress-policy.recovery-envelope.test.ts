/**
 * Recovery envelope handed to the in-character rewrite when a planned reply is
 * rejected. The envelope carries only the validator's evidence contract: the
 * financial observation providers that ground a corrected quantity (plus the
 * CURRENT_TIME observation for a rejected stated time), alongside the complete
 * saved recovery context. A rejected stated time is answered from the
 * provider's own rendering without a second model pass.
 */
import { describe, expect, it, vi } from "vitest";
import type { ActionResult, IAgentRuntime, Memory } from "@elizaos/core";
import { resolvePlannedReplyEgress } from "./egress-policy";

const PROVIDER_MARKER = "complete-provider-evidence-marker";
const WALLET_MARKER = "wallet-observation-evidence-marker";

function makeRuntime(rewriteText: string) {
	const useModel = vi.fn(async (_model: string, params: { prompt: string }) =>
		JSON.stringify(
			params.prompt.startsWith("Review recovered reply grounding.")
				? {
						grounded: true,
						completedChangeClaim: false,
						reason: "The fixture uncertainty statement is supported.",
					}
				: { response: rewriteText, effectReceiptIds: [] },
		),
	);
	const runtime = {
		agentId: "00000000-0000-0000-0000-000000000001",
		character: { name: "Eliza", bio: "" },
		actions: [],
		useModel,
		getSetting: () => undefined,
		reportError: vi.fn(),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	} as unknown as IAgentRuntime;
	return { runtime, useModel };
}

function makeMessage(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000010",
		entityId: "00000000-0000-0000-0000-000000000002",
		roomId: "00000000-0000-0000-0000-000000000003",
		content: { text, source: "test" },
		createdAt: Date.now(),
	} as Memory;
}

const providers = {
	RECENT_MESSAGES: {
		text: `${PROVIDER_MARKER} ${"x".repeat(5000)}`,
		values: {},
		data: {},
	},
} as unknown as NonNullable<
	Parameters<typeof resolvePlannedReplyEgress>[0]["providers"]
>;

function rewritePrompt(useModel: ReturnType<typeof makeRuntime>["useModel"]) {
	return useModel.mock.calls[0]?.[1].prompt ?? "";
}

describe("resolvePlannedReplyEgress recovery envelope", () => {
	it("does not ship the provider store when correcting an unproven side-effect claim", async () => {
		const { runtime, useModel } = useModelHarness(
			"Deleted your dentist appointment from the calendar.",
		);
		await expect(
			resolvePlannedReplyEgress({
				runtime,
				message: makeMessage("delete the dentist appointment from my calendar"),
				reply: "Deleted your dentist appointment from the calendar.",
				providers,
				actionResults: [] as ActionResult[],
			}),
		).rejects.toMatchObject({ code: "REPLY_GROUNDING_FAILED" });
		expect(useModel).toHaveBeenCalled();
		const prompt = rewritePrompt(useModel);
		expect(prompt).toContain("completed_side_effect");
		expect(prompt).not.toContain(PROVIDER_MARKER);
	});

	it("ships only the wallet observation evidence when correcting an unsupported holding", async () => {
		const { runtime, useModel } = useModelHarness(
			"I could not verify that balance.",
		);
		const recovery = {
			context:
				"Complete original λ雪 standing constraint and prior turn.\n".repeat(
					1200,
				),
			pendingToolCalls: [{ id: "pending-original", name: "READ_BALANCE" }],
			evaluatorOutputs: [
				{ decision: "CONTINUE", reason: "verification pending" },
			],
			ownerExclusiveDisclosureUsed: false,
		};
		const result = await resolvePlannedReplyEgress({
			runtime,
			message: makeMessage("what is my SOL balance?"),
			reply: "Your wallet balance is 4 SOL.",
			providers: {
				...providers,
				"solana-wallet": {
					text: `${WALLET_MARKER} observed 2 SOL`,
					values: {},
					data: { items: [{ symbol: "SOL", uiAmount: 2 }], totalSol: "2" },
				},
			} as typeof providers,
			actionResults: [] as ActionResult[],
			recovery,
		});
		expect(result).toEqual({
			text: "I could not verify that balance.",
			effectReceiptIds: [],
		});
		expect(useModel).toHaveBeenCalled();
		const prompt = rewritePrompt(useModel);
		expect(prompt).toContain("financial_holding");
		// The validator's own evidence grounds the corrected quantity in full.
		expect(prompt).toContain(WALLET_MARKER);
		// The room history provider is not part of that evidence contract.
		expect(prompt).not.toContain(PROVIDER_MARKER);
		expect(prompt).toContain(JSON.stringify(recovery.context));
		expect(prompt).toContain(JSON.stringify(recovery.pendingToolCalls));
		expect(prompt).toContain(JSON.stringify(recovery.evaluatorOutputs));
	});
});

function useModelHarness(rewriteText: string) {
	return makeRuntime(rewriteText);
}

describe("resolvePlannedReplyEgress stated time", () => {
	it("answers a current-time question from the provider without a model pass when the reply invented a date", async () => {
		const { runtime, useModel } = makeRuntime("unused");
		const result = await resolvePlannedReplyEgress({
			runtime,
			message: makeMessage("what time is it right now for me?"),
			reply:
				"Sunday, November 22, 2026 at 5:01:28 PM EST. (in your local time)",
			providers: {
				...providers,
				CURRENT_TIME: {
					text: "",
					values: {},
					data: {
						iso: "2026-09-11T15:18:30.625Z",
						date: "2026-09-11",
						time: "11:18:30",
						dayOfWeek: "Friday",
						humanReadable: "Friday, September 11, 2026 at 11:18:30 AM EDT",
						timeZone: "America/New_York",
					},
				},
			} as never,
			actionResults: [] as ActionResult[],
		});
		expect(result.text).toBe(
			"It's Friday, September 11, 2026 at 11:18:30 AM EDT.",
		);
		expect(useModel).not.toHaveBeenCalled();
	});
});
