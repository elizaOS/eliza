/** Catalog inspection must finish from its actual read without licensing
 * unrelated domain claims or repeated discovery calls. */
import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerRuntime } from "../planner-types";

const discover = {
	name: "DISCOVER_TOOLS",
	description: "Inspect schemas",
	parameters: { type: "object" as const, properties: {} },
};
const read = {
	name: "READ",
	description: "Read current records",
	parameters: { type: "object" as const, properties: {} },
};
function call(name: string, text?: string) {
	return {
		text: "",
		toolCalls: [
			{
				id: name,
				name,
				arguments: { eliza_turn_scope: "final", ...(text ? { text } : {}) },
			},
		],
	};
}

describe("explicit catalog-only requests", () => {
	it.each([
		{ domainTools: true, candidates: ["DISCOVER_TOOLS"] },
		{ domainTools: false, candidates: ["DISCOVER_TOOLS"] },
		{ domainTools: true, candidates: ["DISCOVER_TOOLS", "READ"] },
	])(
		"finishes after successful requested discovery (domain tools exposed=%s)",
		async ({ domainTools, candidates }) => {
			const useModel = vi.fn<PlannerRuntime["useModel"]>(async (type) =>
				type === ModelType.ACTION_PLANNER
					? call("DISCOVER_TOOLS")
					: JSON.stringify({
							decision: "FINISH",
							success: true,
							thought: "Requested catalog read succeeded.",
							messageToUser: "The family exposes READ.",
						}),
			);
			const execute = vi.fn(async () => ({
				success: true,
				data: { loadedTools: ["READ"] },
			}));
			const result = await runPlannerLoop({
				runtime: { useModel },
				context: {
					id: "catalog-turn",
					events: [
						{
							id: "stage1",
							type: "message_handler",
							source: "message-service",
							metadata: {
								plan: {
									candidateActions: candidates,
									intents: ["inspect available tools"],
								},
							},
						},
					],
				},
				tools: domainTools ? [discover, read] : [discover],
				requireNonTerminalToolCall: true,
				executeToolCall: execute,
			});
			expect(useModel).toHaveBeenCalledTimes(2);
			expect(execute).toHaveBeenCalledTimes(1);
			expect(useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
			]);
			expect(result.finalMessage ?? result.evaluator?.messageToUser).toBe(
				"The family exposes READ.",
			);
		},
	);

	it.each([
		"compound",
		"untrusted-plan",
		"failed-discovery",
		"no-discovery",
	] as const)("keeps execution evidence required for %s", async (scenario) => {
		let recordRead = false;
		const catalogOnly = scenario !== "compound";
		const replies = [
			...(scenario === "no-discovery" ? [] : [call("DISCOVER_TOOLS")]),
			call("REPLY", "The record says complete."),
			call("READ"),
		];
		const useModel = vi.fn<PlannerRuntime["useModel"]>(async (type) => {
			if (type !== ModelType.ACTION_PLANNER)
				return JSON.stringify({
					decision: recordRead ? "FINISH" : "CONTINUE",
					success: recordRead,
					thought: "Actual record read",
					...(recordRead ? { messageToUser: "Verified current record." } : {}),
				});
			const next = replies.shift();
			if (!next) throw new Error("Unexpected extra planning call");
			return next;
		});
		const execute = vi.fn(async ({ name }: { name: string }) => {
			if (name === "READ") recordRead = true;
			return {
				success: !(
					name === "DISCOVER_TOOLS" && scenario === "failed-discovery"
				),
				text: name === "READ" ? "Verified current record." : "Catalog result",
			};
		});
		const result = await runPlannerLoop({
			runtime: { useModel },
			context: {
				id: "guard-turn",
				events: [
					{
						id: "stage1",
						type: "message_handler",
						source:
							scenario === "untrusted-plan"
								? "custom-provider"
								: "message-service",
						metadata: {
							plan: {
								candidateActions: catalogOnly
									? ["DISCOVER_TOOLS"]
									: ["DISCOVER_TOOLS", "READ"],
								intents: ["read records"],
							},
						},
					},
				],
			},
			tools: [discover, read],
			requireNonTerminalToolCall: true,
			executeToolCall: execute,
		});
		expect(execute.mock.calls.map(([tool]) => tool.name)).toContain("READ");
		const reply = result.finalMessage ?? result.evaluator?.messageToUser;
		if (scenario === "failed-discovery") {
			// A later unrelated read cannot erase the failed catalog request.
			expect(reply).toContain("failed");
		} else expect(reply).toBe("Verified current record.");
	});
});
