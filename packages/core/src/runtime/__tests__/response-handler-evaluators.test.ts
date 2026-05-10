import { describe, expect, it } from "bun:test";
import type { IAgentRuntime } from "../../types/runtime";
import type { Memory } from "../../types/memory";
import type { State } from "../../types/state";
import type { MessageHandlerResult } from "../../types/components";
import {
	runResponseHandlerEvaluators,
	type ResponseHandlerEvaluator,
} from "../response-handler-evaluators";

function runtimeWith(
	evaluators: ResponseHandlerEvaluator[],
): IAgentRuntime {
	return {
		agentId: "00000000-0000-0000-0000-000000000001",
		responseHandlerEvaluators: evaluators,
		logger: { warn: () => undefined, debug: () => undefined },
	} as unknown as IAgentRuntime;
}

const message = {
	id: "00000000-0000-0000-0000-000000000002",
	roomId: "00000000-0000-0000-0000-000000000003",
	content: { text: "thread this" },
} as Memory;

const state = {} as State;

function handler(): MessageHandlerResult {
	return {
		processMessage: "RESPOND",
		thought: "route",
		plan: { contexts: ["simple"], reply: "ok", simple: true },
	};
}

describe("response-handler evaluators", () => {
	it("applies deterministic patches after Stage 1 parse", async () => {
		const messageHandler = handler();
		const result = await runResponseHandlerEvaluators({
			runtime: runtimeWith([
				{
					name: "threads",
					priority: 10,
					shouldRun: () => true,
					evaluate: () => ({
						requiresTool: true,
						simple: false,
						clearReply: true,
						setContexts: ["tasks", "missing-context"],
						addContexts: ["messaging"],
						addCandidateActions: ["lifeops_thread_control"],
						addParentActionHints: ["LIFEOPS_THREAD_CONTROL"],
						addContextSlices: ["active thread available"],
						debug: ["patched"],
					}),
				},
			]),
			message,
			state,
			messageHandler,
			availableContexts: [
				{ id: "tasks" },
				{ id: "messaging" },
				{ id: "general" },
			],
		});

		expect(messageHandler.plan.contexts).toEqual(["tasks", "messaging"]);
		expect(messageHandler.plan.reply).toBeUndefined();
		expect(messageHandler.plan.requiresTool).toBe(true);
		expect(messageHandler.plan.simple).toBe(false);
		expect(messageHandler.plan.candidateActions).toEqual([
			"lifeops_thread_control",
		]);
		expect(messageHandler.plan.parentActionHints).toEqual([
			"LIFEOPS_THREAD_CONTROL",
		]);
		expect(messageHandler.plan.contextSlices).toEqual([
			"active thread available",
		]);
		expect(result.activeEvaluators).toEqual(["threads"]);
		expect(result.appliedPatches[0]?.changed).toContain("contexts:set");
	});

	it("orders patchers and isolates failures", async () => {
		const messageHandler = handler();
		const result = await runResponseHandlerEvaluators({
			runtime: runtimeWith([
				{
					name: "b",
					priority: 20,
					shouldRun: () => true,
					evaluate: () => ({ addCandidateActions: ["second"] }),
				},
				{
					name: "a",
					priority: 10,
					shouldRun: () => true,
					evaluate: () => ({ addCandidateActions: ["first"] }),
				},
				{
					name: "broken",
					priority: 15,
					shouldRun: () => true,
					evaluate: () => {
						throw new Error("boom");
					},
				},
			]),
			message,
			state,
			messageHandler,
			availableContexts: [],
		});

		expect(messageHandler.plan.candidateActions).toEqual(["first", "second"]);
		expect(result.activeEvaluators).toEqual(["a", "broken", "b"]);
		expect(result.errors).toEqual([
			{ evaluatorName: "broken", error: "boom" },
		]);
	});
});
