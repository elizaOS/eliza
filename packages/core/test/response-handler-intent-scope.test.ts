/** Typed intent-scope replacement invalidates only declared derived bindings. */
import { describe, expect, it, vi } from "vitest";
import {
	type ResponseHandlerPatch,
	runResponseHandlerEvaluators,
} from "../src/runtime/response-handler-evaluators";
import type { MessageHandlerResult } from "../src/types/components";
import type { Memory } from "../src/types/memory";
import type { IAgentRuntime } from "../src/types/runtime";

function fixture() {
	const handler: MessageHandlerResult = {
		processMessage: "RESPOND",
		thought: "raw model interpretation",
		plan: {
			contexts: ["calendar"],
			intents: ["Invented subrequest"],
			calendarReadBindings: [{ intentId: "intent:1" }],
			otherBindings: [{ keep: true }],
			completionContext: {
				mode: "full",
				sourceSetId: "test",
				complete: true,
				relevantSourceIds: [],
				constraintSourceIds: [],
				referentSourceIds: [],
				pendingIntentSourceIds: [],
			},
			contextSlices: ["Authorized source evidence"],
			deterministicToolCall: { name: "OLD", params: {} },
		},
	};
	const runtime = {
		responseHandlerEvaluators: [],
		reportError: vi.fn(),
		logger: { warn: vi.fn() },
	} as unknown as IAgentRuntime;
	return {
		runtime,
		message: { content: { text: "Original request" } } as Memory,
		state: { values: {}, data: {}, text: "" },
		messageHandler: handler,
		availableContexts: [],
	};
}

describe("response-handler intent scope replacement", () => {
	it("replaces derived intents and bindings while preserving unrelated source evidence", async () => {
		const args = fixture();
		const before = structuredClone(args.messageHandler);
		const result = await runResponseHandlerEvaluators({
			...args,
			evaluators: [
				{
					name: "test.scope",
					shouldRun: () => true,
					evaluate: () => ({
						replaceIntentScope: {
							intents: ["Original request"],
							invalidateBindings: ["calendarReadBindings"],
						},
					}),
				},
			],
		});
		expect(result.errors).toEqual([]);
		expect(args.messageHandler.plan.intents).toEqual(["Original request"]);
		expect(args.messageHandler.plan.calendarReadBindings).toBeUndefined();
		expect(args.messageHandler.plan.deterministicToolCall).toBeUndefined();
		expect(args.messageHandler.plan.otherBindings).toEqual(
			before.plan.otherBindings,
		);
		expect(args.messageHandler.plan.contextSlices).toEqual(
			before.plan.contextSlices,
		);
		expect(args.messageHandler.plan.completionContext).toEqual(
			before.plan.completionContext,
		);
		expect(result.appliedPatches[0]?.changed).toContain(
			"intentBinding:clear:calendarReadBindings",
		);
	});
	it.each(["contexts", "completionContext", "__proto__", "reply"])(
		"rejects non-binding field %s before any patch mutation",
		async (field) => {
			const args = fixture();
			const before = structuredClone(args.messageHandler);
			const patch = {
				processMessage: "IGNORE",
				clearCandidateActions: true,
				replaceIntentScope: {
					intents: ["Original request"],
					invalidateBindings: [field],
				},
			} as ResponseHandlerPatch;
			const result = await runResponseHandlerEvaluators({
				...args,
				evaluators: [
					{
						name: "test.invalid",
						shouldRun: () => true,
						evaluate: () => patch,
					},
				],
			});
			expect(result.errors).toHaveLength(1);
			expect(result.candidateActionsClearedByEvaluators).toBe(false);
			expect(args.messageHandler).toEqual(before);
		},
	);
	it("rejects empty replacement intents before any patch mutation", async () => {
		const args = fixture();
		const before = structuredClone(args.messageHandler);
		const result = await runResponseHandlerEvaluators({
			...args,
			evaluators: [
				{
					name: "test.empty",
					shouldRun: () => true,
					evaluate: () => ({
						processMessage: "IGNORE",
						replaceIntentScope: {
							intents: [],
							invalidateBindings: ["calendarReadBindings"],
						},
					}),
				},
			],
		});
		expect(result.errors).toHaveLength(1);
		expect(result.candidateActionsClearedByEvaluators).toBe(false);
		expect(args.messageHandler).toEqual(before);
	});
});
