/** Exercises default planner specialization through real dispatch and preflight
 * rendering while preserving schemas, fallback protocols and caller templates. */
import { describe, expect, it, vi } from "vitest";
import {
	buildPlannerTemplate,
	plannerReplyTemplate,
	plannerRequiredPolicy,
	plannerSchema,
	plannerTemplate,
} from "../../../../../plugins/plugin-assistant/src/prompts/planner.ts";
import {
	buildInitialPlannerModelInputBudget,
	runPlannerLoop,
	withTurnScopeToolArg,
} from "../../../../../plugins/plugin-assistant/src/runtime/planner-loop.ts";
import type { ToolDefinition } from "../../types/model";
import { buildModelInputBudget } from "../model-input-budget";
import type { PlannerRuntime } from "../planner-types";

const notes: ToolDefinition = {
	name: "NOTES_GET",
	parameters: {
		type: "object",
		properties: { id: { type: "string" } },
		required: ["id"],
	},
};
const reply: ToolDefinition = {
	name: "REPLY",
	parameters: {
		type: "object",
		properties: { text: { type: "string" } },
	},
};
const context = {
	id: "planner-template-tools",
	events: [
		{
			id: "current-request",
			type: "message" as const,
			message: {
				role: "user" as const,
				content: {
					text: "Explain the name OWNER_GOALS without changing data.",
				},
			},
		},
	],
};
const finalReply = {
	text: "",
	toolCalls: [
		{
			id: "reply",
			name: "REPLY",
			arguments: { text: "No changes made.", eliza_turn_scope: "final" },
		},
	],
};

function stageInstructions(template: string): string {
	return `planner_stage:\n${template.split("context_object:")[0].trim()}`;
}

describe("planner default template follows the actual exposed tools", () => {
	it("omits exactly one inactive example while retaining every other authored byte", () => {
		const fullLines = plannerTemplate.split("\n");
		const exampleLines = fullLines.filter((line) =>
			line.startsWith("- owner goal save/create/update/review "),
		);
		expect(exampleLines).toHaveLength(1);
		expect(buildPlannerTemplate({ includeOwnerGoalsExample: false })).toBe(
			fullLines.filter((line) => line !== exampleLines[0]).join("\n"),
		);
	});

	it.each([
		{ name: "unknown tools", tools: undefined, includeGoal: true },
		{ name: "schema-only", tools: [], includeGoal: true },
		{ name: "notes", tools: [notes, reply], includeGoal: false },
		{
			name: "exact owner goal tool",
			tools: [notes, reply, { name: "OWNER_GOALS" }],
			includeGoal: true,
		},
		{
			name: "different child tool name",
			tools: [notes, reply, { name: "OWNER_GOALS_CREATE" }],
			includeGoal: false,
		},
	])("keeps preflight and dispatch aligned for $name", async (fixture) => {
		const toolsBefore = structuredClone(fixture.tools);
		const contextBefore = structuredClone(context);
		const useModel = vi.fn<PlannerRuntime["useModel"]>(async () =>
			fixture.tools?.length
				? finalReply
				: JSON.stringify({
						thought: "No work requested.",
						toolCalls: [],
						messageToUser: "No changes made.",
					}),
		);
		const runtime = { useModel };
		const budget = buildInitialPlannerModelInputBudget({
			runtime,
			context,
			tools: fixture.tools,
		});
		const executeToolCall = vi.fn();
		await runPlannerLoop({
			runtime,
			context,
			tools: fixture.tools,
			executeToolCall,
		});
		const sent = useModel.mock.calls[0]?.[1];
		if (!sent) throw new Error("Missing actual planner dispatch");
		const template = buildPlannerTemplate({
			includeOwnerGoalsExample: fixture.includeGoal,
			nativeToolsOnly: Boolean(fixture.tools?.length),
		});
		expect(
			sent.messages.find((message) => message.role === "system")?.content,
		).toBe(stageInstructions(template));
		expect(
			sent.promptSegments?.find((segment) => segment.stable)?.content,
		).toBe(stageInstructions(template));
		// Preflight measures the same rendered messages and original schemas;
		// dispatch adds the existing reserved scope argument afterwards.
		expect(budget.estimatedInputTokens).toBe(
			buildModelInputBudget({
				messages: sent.messages,
				promptSegments: sent.promptSegments,
				tools: fixture.tools,
				estimationMode: "utf8-upper-bound",
			}).estimatedInputTokens,
		);
		if (fixture.tools?.length) {
			expect(sent.tools).toEqual(withTurnScopeToolArg(fixture.tools, template));
			expect(sent.toolChoice).toBe("required");
			expect(sent.responseSchema).toBeUndefined();
			expect(template).not.toContain("plain-JSON fallback");
			expect(template).not.toContain("Plain-JSON fallback");
			expect(template).toContain(
				"Final scope still requires result verification.",
			);
		} else {
			expect(template).toContain("plain-JSON fallback");
			expect(sent.tools).toBeUndefined();
			expect(sent.responseSchema).toEqual(plannerSchema);
		}
		for (const rule of Object.values(plannerRequiredPolicy)) {
			expect(template).toContain(rule);
		}
		expect(fixture.tools).toEqual(toolsBefore);
		expect(context).toEqual(contextBefore);
		expect(executeToolCall).not.toHaveBeenCalled();
	});

	it("preserves an optimized template even when only the exact default differs", async () => {
		const custom = `Custom preface.\n${plannerTemplate}`;
		const useModel = vi.fn<PlannerRuntime["useModel"]>(async () => finalReply);
		await runPlannerLoop({
			runtime: {
				useModel,
				getService: () => ({ getPrompt: () => ({ prompt: custom }) }),
			},
			context,
			tools: [notes, reply],
			executeToolCall: vi.fn(),
		});
		expect(
			useModel.mock.calls[0]?.[1].messages.find(
				(message) => message.role === "system",
			)?.content,
		).toBe(stageInstructions(custom));
	});

	it("restores the owner example after discovery changes the actual exposed tools", async () => {
		const tools = [notes, reply, { name: "DISCOVER_TOOLS" }];
		const useModel = vi.fn<PlannerRuntime["useModel"]>();
		useModel
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "discover",
						name: "DISCOVER_TOOLS",
						arguments: {
							names: ["OWNER_GOALS"],
							eliza_turn_scope: "more_work_pending",
						},
					},
				],
			})
			.mockResolvedValueOnce(finalReply);
		const executeToolCall = vi.fn(async () => {
			tools.push({ name: "OWNER_GOALS" });
			return { success: true, data: { loadedTools: ["OWNER_GOALS"] } };
		});
		await runPlannerLoop({
			runtime: { useModel },
			context,
			tools,
			executeToolCall,
			evaluate: async () => ({ success: true, decision: "FINISH" }),
		});
		expect(useModel).toHaveBeenCalledTimes(2);
		expect(
			useModel.mock.calls.map(
				([, sent]) =>
					sent.messages.find((message) => message.role === "system")?.content,
			),
		).toEqual([
			stageInstructions(
				buildPlannerTemplate({
					includeOwnerGoalsExample: false,
					nativeToolsOnly: true,
				}),
			),
			stageInstructions(buildPlannerTemplate({ nativeToolsOnly: true })),
		]);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(useModel.mock.calls[1]?.[1].tools).toContainEqual({
			name: "OWNER_GOALS",
		});
	});

	it("leaves the coding template independent of owner-goal exposure", async () => {
		const systems: unknown[] = [];
		for (const tools of [
			[notes, reply],
			[notes, reply, { name: "OWNER_GOALS" }],
		]) {
			const captureStop = new Error("Stop after capturing coding input");
			const useModel = vi.fn<PlannerRuntime["useModel"]>(async () => {
				throw captureStop;
			});
			await expect(
				runPlannerLoop({
					runtime: { useModel },
					context,
					tools,
					codingMode: true,
					executeToolCall: vi.fn(),
				}),
			).rejects.toBe(captureStop);
			systems.push(
				useModel.mock.calls[0]?.[1].messages.find(
					(message) => message.role === "system",
				)?.content,
			);
		}
		expect(systems[0]).toEqual(systems[1]);
		expect(systems[0]).not.toEqual(stageInstructions(plannerTemplate));
	});

	it("keeps settled reply-only rendering and its schema despite the original tool catalog", async () => {
		const useModel = vi.fn<PlannerRuntime["useModel"]>(async () =>
			JSON.stringify({
				thought: "Answer from the settled result.",
				toolCalls: [],
				messageToUser: "The note says hello.",
				completed: true,
			}),
		);
		const executeToolCall = vi.fn();
		await runPlannerLoop({
			runtime: { useModel },
			context,
			tools: [notes, reply],
			postToolReplySeed: {
				toolCall: { id: "read", name: "NOTES_GET", params: { id: "note" } },
				result: {
					success: true,
					text: "hello",
					transcriptVisibility: "internal",
					modelReplyRequired: true,
				},
			},
			executeToolCall,
		});
		const sent = useModel.mock.calls[0]?.[1];
		expect(
			sent?.messages.find((message) => message.role === "system")?.content,
		).toBe(stageInstructions(plannerReplyTemplate));
		expect(sent?.tools).toBeUndefined();
		expect(sent?.responseSchema).toEqual(plannerSchema);
		expect(executeToolCall).not.toHaveBeenCalled();
	});
});
