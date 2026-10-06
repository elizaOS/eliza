/** Typed intent-scope replacement invalidates only declared inferred operation fields. */
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
			visualContinuation: { disposition: "planning" },
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
		let observed: string[] = [];
		const result = await runResponseHandlerEvaluators({
			...args,
			evaluators: [
				{
					name: "test.scope",
					shouldRun: () => true,
					evaluate: () => ({
						replaceIntentScope: {
							intents: ["Original request"],
							invalidateFields: ["calendarReadBindings", "visualContinuation"],
						},
					}),
				},
				{
					name: "test.observe",
					priority: 200,
					shouldRun: () => true,
					evaluate: ({ invalidatedScopeFields }) => {
						observed = [...(invalidatedScopeFields ?? [])];
						return undefined;
					},
				},
			],
		});
		expect(observed).toEqual(["calendarReadBindings", "visualContinuation"]);
		expect(args.messageHandler.plan.visualContinuation).toBeUndefined();
		expect(args.messageHandler.plan).not.toHaveProperty(
			"invalidatedScopeFields",
		);
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
			"intentField:invalidate:calendarReadBindings",
		);
	});
	it.each([
		"contexts",
		"completionContext",
		"contextSlices",
		"intents",
		"__proto__",
		"constructor",
		"reply",
		"sourceSetId",
		"currentSourceRevisions",
		"effectReceipts",
		"messages",
		"originalMessages",
		"history",
		"metadata",
		"invalidatedScopeFields",
		"plan.visualContinuation",
		"visual-continuation",
		"",
		"visualContinuation\0",
	])(
		"rejects protected or malformed field %s before any patch mutation",
		async (field) => {
			const args = fixture();
			const before = structuredClone(args.messageHandler);
			const patch = {
				processMessage: "IGNORE",
				clearCandidateActions: true,
				replaceIntentScope: {
					intents: ["Original request"],
					invalidateFields: [field],
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
							invalidateFields: ["calendarReadBindings"],
						},
					}),
				},
			],
		});
		expect(result.errors).toHaveLength(1);
		expect(result.candidateActionsClearedByEvaluators).toBe(false);
		expect(args.messageHandler).toEqual(before);
	});
	it("does not carry invalidations across runs or read forged plan fields", async () => {
		const args = fixture();
		args.messageHandler.plan.invalidatedScopeFields = ["visualContinuation"];
		const observations: string[][] = [];
		const observe = {
			name: "test.observe",
			priority: 200,
			shouldRun: () => true,
			evaluate: ({
				invalidatedScopeFields,
			}: {
				invalidatedScopeFields?: ReadonlySet<string>;
			}) => {
				observations.push([...(invalidatedScopeFields ?? [])]);
				return undefined;
			},
		};
		await runResponseHandlerEvaluators({
			...args,
			evaluators: [
				{
					name: "test.invalidate",
					shouldRun: () => true,
					evaluate: () => ({
						replaceIntentScope: {
							intents: ["Original request"],
							invalidateFields: ["visualContinuation"],
						},
					}),
				},
				observe,
			],
		});
		await runResponseHandlerEvaluators({ ...args, evaluators: [observe] });
		expect(observations).toEqual([["visualContinuation"], []]);
	});
});
