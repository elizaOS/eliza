/**
 * Integration coverage for the always-on core Stage-1 guard evaluators via
 * `runResponseHandlerEvaluators`: the unknown-context fallback rewrites an
 * invalid tool-committed selection to `general` (pinning requiresTool), the
 * execution-claim guard promotes a promise-shaped simple reply to planning
 * with the canonical interim ack, and untouched shapes stay untouched.
 * Stub runtime; no model.
 */
import { describe, expect, it, vi } from "vitest";
import type { MessageHandlerResult } from "../types/components";
import type { Memory } from "../types/memory";
import type { IAgentRuntime } from "../types/runtime";
import type { State } from "../types/state";
import { runResponseHandlerEvaluators } from "./response-handler-evaluators";

function makeRuntime(): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-000000000001",
		reportError: vi.fn(),
		responseHandlerEvaluators: [],
		getSetting: () => null,
		logger: { warn: vi.fn(), debug: vi.fn() },
	} as unknown as IAgentRuntime;
}

const message = {
	id: "00000000-0000-0000-0000-000000000002",
	roomId: "00000000-0000-0000-0000-000000000003",
	content: { text: "can you set a check-in?" },
} as Memory;

const state = {} as State;

const AVAILABLE = [{ id: "simple" }, { id: "general" }];

describe("core.stage1_context_fallback (invalid-context false-promise acks)", () => {
	it("rewrites the live tj-d3bcf5b3600f72 shape to general and pins requiresTool", async () => {
		const messageHandler: MessageHandlerResult = {
			processMessage: "RESPOND",
			thought: "",
			plan: {
				contexts: ["tasks"],
				reply: "on it. i'll nudge everyone in 10 minutes if nothing's landed.",
				requiresTool: true,
				candidateActions: ["OWNER_REMINDERS"],
			},
		};
		const result = await runResponseHandlerEvaluators({
			runtime: makeRuntime(),
			message,
			state,
			messageHandler,
			availableContexts: AVAILABLE,
		});
		expect(messageHandler.plan.contexts).toEqual(["general"]);
		expect(messageHandler.plan.requiresTool).toBe(true);
		// Stage-1 candidates survive so the planner still sees them.
		expect(messageHandler.plan.candidateActions).toEqual(["OWNER_REMINDERS"]);
		expect(result.activeEvaluators).toContain("core.stage1_context_fallback");
	});

	it("keeps known non-simple contexts and only drops the unknown id", async () => {
		const messageHandler: MessageHandlerResult = {
			processMessage: "RESPOND",
			thought: "",
			plan: {
				contexts: ["general", "made_up"],
				reply: "On it.",
				requiresTool: true,
			},
		};
		await runResponseHandlerEvaluators({
			runtime: makeRuntime(),
			message,
			state,
			messageHandler,
			availableContexts: AVAILABLE,
		});
		expect(messageHandler.plan.contexts).toEqual(["general"]);
	});

	it("does not run when every selected context is available", async () => {
		const messageHandler: MessageHandlerResult = {
			processMessage: "RESPOND",
			thought: "",
			plan: { contexts: ["simple"], reply: "the answer is 4" },
		};
		const result = await runResponseHandlerEvaluators({
			runtime: makeRuntime(),
			message,
			state,
			messageHandler,
			availableContexts: AVAILABLE,
		});
		expect(result.activeEvaluators).not.toContain(
			"core.stage1_context_fallback",
		);
		expect(messageHandler.plan.contexts).toEqual(["simple"]);
	});

	it("guards run AFTER registered evaluators and judge their rewritten plan", async () => {
		const messageHandler: MessageHandlerResult = {
			processMessage: "RESPOND",
			thought: "",
			plan: { contexts: ["simple"], reply: "sounds good", requiresTool: false },
		};
		const runtime = {
			...makeRuntime(),
			responseHandlerEvaluators: [
				{
					name: "custom.rewrites_reply_to_promise",
					priority: 50,
					shouldRun: () => true,
					evaluate: () => ({ reply: "i'll re-run the t=3 action now" }),
				},
			],
		} as unknown as IAgentRuntime;
		const result = await runResponseHandlerEvaluators({
			runtime,
			message,
			state,
			messageHandler,
			availableContexts: AVAILABLE,
		});
		expect(result.activeEvaluators).toEqual([
			"custom.rewrites_reply_to_promise",
			"core.stage1_execution_claim_guard",
		]);
		// The guard judged the REWRITTEN reply — proof it runs last.
		expect(messageHandler.plan.reply).toBe("On it.");
		expect(messageHandler.plan.contexts).toEqual(["general"]);
	});
});

describe("core.stage1_execution_claim_guard (fabricated execution narrative)", () => {
	it("promotes the live tj-cc509ce7e91f86 shape to planning with the interim ack", async () => {
		const messageHandler: MessageHandlerResult = {
			processMessage: "RESPOND",
			thought: "",
			plan: {
				contexts: ["simple"],
				reply:
					"makes sense. it's a binary outcome now. i'm sending 10 and i'll paste the exact return here as soon as it hits.",
				requiresTool: false,
			},
		};
		const result = await runResponseHandlerEvaluators({
			runtime: makeRuntime(),
			message,
			state,
			messageHandler,
			availableContexts: AVAILABLE,
		});
		expect(result.activeEvaluators).toContain(
			"core.stage1_execution_claim_guard",
		);
		expect(messageHandler.plan.contexts).toEqual(["general"]);
		expect(messageHandler.plan.requiresTool).toBe(true);
		expect(messageHandler.plan.reply).toBe("On it.");
	});

	it("leaves an honest simple reply alone", async () => {
		const messageHandler: MessageHandlerResult = {
			processMessage: "RESPOND",
			thought: "",
			plan: {
				contexts: ["simple"],
				reply: "nothing is running on my end — paste the result when it lands.",
				requiresTool: false,
			},
		};
		const result = await runResponseHandlerEvaluators({
			runtime: makeRuntime(),
			message,
			state,
			messageHandler,
			availableContexts: AVAILABLE,
		});
		expect(result.activeEvaluators).not.toContain(
			"core.stage1_execution_claim_guard",
		);
		expect(messageHandler.plan.reply).toBe(
			"nothing is running on my end — paste the result when it lands.",
		);
		expect(messageHandler.plan.contexts).toEqual(["simple"]);
	});

	it("does not fire when the turn already routed tool work (legitimate ack)", async () => {
		const messageHandler: MessageHandlerResult = {
			processMessage: "RESPOND",
			thought: "",
			plan: {
				contexts: ["general"],
				reply: "On it — i'll paste the output here as soon as it lands.",
				requiresTool: true,
				candidateActions: ["SHELL"],
			},
		};
		const result = await runResponseHandlerEvaluators({
			runtime: makeRuntime(),
			message,
			state,
			messageHandler,
			availableContexts: AVAILABLE,
		});
		expect(result.activeEvaluators).not.toContain(
			"core.stage1_execution_claim_guard",
		);
		expect(messageHandler.plan.reply).toBe(
			"On it — i'll paste the output here as soon as it lands.",
		);
	});

	it("does not fire on IGNORE turns", async () => {
		const messageHandler: MessageHandlerResult = {
			processMessage: "IGNORE",
			thought: "",
			plan: { contexts: [], reply: "i'll paste the output here right away" },
		};
		const result = await runResponseHandlerEvaluators({
			runtime: makeRuntime(),
			message,
			state,
			messageHandler,
			availableContexts: AVAILABLE,
		});
		expect(result.activeEvaluators).not.toContain(
			"core.stage1_execution_claim_guard",
		);
	});

	it("can be disabled with ELIZA_STAGE1_EXECUTION_CLAIM_GUARD=off", async () => {
		const runtime = {
			...makeRuntime(),
			getSetting: (key: string) =>
				key === "ELIZA_STAGE1_EXECUTION_CLAIM_GUARD" ? "off" : null,
		} as unknown as IAgentRuntime;
		const messageHandler: MessageHandlerResult = {
			processMessage: "RESPOND",
			thought: "",
			plan: {
				contexts: ["simple"],
				reply: "i'll re-run the t=3 action now",
				requiresTool: false,
			},
		};
		const result = await runResponseHandlerEvaluators({
			runtime,
			message,
			state,
			messageHandler,
			availableContexts: AVAILABLE,
		});
		expect(result.activeEvaluators).not.toContain(
			"core.stage1_execution_claim_guard",
		);
		expect(messageHandler.plan.reply).toBe("i'll re-run the t=3 action now");
	});
});
