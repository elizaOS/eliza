/** Tests complete, permission-scoped schema loading without any live domain effects. */
import { describe, expect, it } from "vitest";
import { buildPlannerToolsFromActions } from "../../actions/to-tool";
import type { Action } from "../../types/components";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import { createPlannerToolDiscoveryAction } from "./tool-discovery";

const runtime = {} as IAgentRuntime;
const message = {} as Memory;

describe("planner tool discovery", () => {
	it("loads complete authorized families, including nested children, without executing them", async () => {
		let executions = 0;
		const completeDescription = `Full selected schema ${"operation detail ".repeat(900)} FINAL_DETAIL`;
		const actions: Action[] = [
			{ name: "VIEWS", description: "Navigate" },
			{
				name: "CALENDAR",
				description: "Calendar",
				subActions: ["EVENTS", "DENIED_CHILD"],
			},
			{ name: "EVENTS", description: "Events", subActions: ["READ_EVENT"] },
			{
				name: "READ_EVENT",
				description: completeDescription,
				parameters: [
					{
						name: "title",
						description: "Exact title",
						required: true,
						schema: { type: "string" },
					},
				],
				handler: async () => {
					executions++;
					return { success: true };
				},
			},
		];
		let loaded: Action[] = [];
		const discovery = createPlannerToolDiscoveryAction(actions, (selected) => {
			loaded = selected;
		});
		expect(discovery.description).not.toContain("DENIED_CHILD");
		const result = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: ["CALENDAR"] },
		});
		expect(result?.success).toBe(true);
		expect(loaded.map((action) => action.name)).toEqual([
			"CALENDAR",
			"EVENTS",
			"READ_EVENT",
		]);
		const tools = buildPlannerToolsFromActions(loaded);
		expect(tools.find((tool) => tool.name === "READ_EVENT")?.description).toBe(
			completeDescription,
		);
		expect(
			tools.find((tool) => tool.name === "READ_EVENT")?.parameters?.required,
		).toContain("title");
		expect(executions).toBe(0);
	});

	it.each([
		{ names: [] },
		{ names: ["VIEWS", "UNAUTHORIZED"] },
		{ names: [null] },
		{ names: ["views"] },
	])(
		"rejects invalid or unavailable names atomically: %j",
		async ({ names }) => {
			let loaded = false;
			const discovery = createPlannerToolDiscoveryAction(
				[{ name: "VIEWS", description: "Navigate" }],
				() => {
					loaded = true;
				},
			);
			const result = await discovery.handler?.(runtime, message, undefined, {
				parameters: { names },
			});
			expect(result?.success).toBe(false);
			expect(loaded).toBe(false);
		},
	);

	it("rejects a registered action using the reserved discovery protocol name", () => {
		expect(() =>
			createPlannerToolDiscoveryAction(
				[{ name: "DISCOVER_TOOLS", description: "Collision" }],
				() => undefined,
			),
		).toThrow("conflicts");
	});
});
