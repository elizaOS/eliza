/**
 * Proves the planner's same-turn deferred-tool lifecycle with a deterministic
 * native-tool model: discovery executes first, appends a previously absent
 * schema, bypasses completion evaluation, and the next model iteration calls
 * the newly available action.
 */
import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../../types/model";
import { DISCOVER_CAPABILITIES_TOOL } from "../capability-discovery";
import { runPlannerLoop } from "../planner-loop";

const LATE_TOOL: ToolDefinition = {
	name: "LATE_ACTION",
	description: "Perform the capability loaded during this turn.",
	type: "function",
	strict: true,
	parameters: {
		type: "object",
		additionalProperties: false,
		properties: { value: { type: "string" } },
		required: ["value"],
	},
};

describe("planner-loop capability discovery", () => {
	it("uses a newly loaded tool on the next iteration of the same turn", async () => {
		const tools: ToolDefinition[] = [DISCOVER_CAPABILITIES_TOOL];
		const observedToolNames: string[][] = [];
		const runtime = {
			useModel: vi.fn(async (_modelType: unknown, params: unknown) => {
				const names = (
					(params as { tools?: ToolDefinition[] }).tools ?? []
				).map((tool) => tool.name);
				observedToolNames.push(names);
				if (!names.includes("LATE_ACTION")) {
					return {
						text: "",
						toolCalls: [
							{
								id: "discover-1",
								name: "DISCOVER_CAPABILITIES",
								arguments: {
									operation: "search",
									query: "late capability",
								},
							},
						],
					};
				}
				return {
					text: "",
					toolCalls: [
						{
							id: "late-1",
							name: "LATE_ACTION",
							arguments: { value: "ready" },
						},
					],
				};
			}),
		};
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "The loaded action completed.",
			messageToUser: "Done.",
		}));
		const executeToolCall = vi.fn(async (call: { name: string }) => {
			if (call.name === "DISCOVER_CAPABILITIES") {
				tools.push(LATE_TOOL);
				return {
					success: true,
					text: "Loaded LATE_ACTION",
					data: { capabilityDiscovery: { activated: ["LATE_ACTION"] } },
					continueChain: true,
				};
			}
			return { success: true, text: "late action completed" };
		});

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx", events: [] },
			tools,
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(observedToolNames[0]).toEqual(["DISCOVER_CAPABILITIES"]);
		expect(observedToolNames[1]).toContain("LATE_ACTION");
		expect(executeToolCall.mock.calls.map(([call]) => call.name)).toEqual([
			"DISCOVER_CAPABILITIES",
			"LATE_ACTION",
		]);
		expect(evaluate).toHaveBeenCalledTimes(1);
	});
});
