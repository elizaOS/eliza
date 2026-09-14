/** Tests complete, permission-scoped schema loading without any live domain effects. */
import { describe, expect, it } from "vitest";
import { buildPlannerToolsFromActions } from "../../actions/to-tool";
import type { Action } from "../../types/components";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import {
	collectDiscoveryCatalogActions,
	createPlannerToolDiscoveryAction,
} from "./tool-discovery";

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
		// One `PARENT: child, child` line per family (a parent without children
		// stands alone), not a JSON array.
		expect(discovery.description).toMatch(/^VIEWS$/m);
		expect(discovery.description).toMatch(/^CALENDAR: EVENTS/m);
		expect(discovery.description).not.toContain('{"name"');
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
			expect(result?.data).toMatchObject({ coachingFailure: true });
			expect(result?.error).toContain("No tools were loaded");
			expect(loaded).toBe(false);
		},
	);

	it("lists a family gated only by context under its own declared contexts and keeps the private and role gates (live: MESSAGE on a general-routed turn)", async () => {
		const actions: Action[] = [
			{ name: "MESSAGE", description: "Messaging", contexts: ["messaging"] },
			{ name: "VIEWS", description: "Navigate", contexts: ["general"] },
			{
				name: "PRIVATE_X",
				description: "Autonomy only",
				contexts: ["general"],
				private: true,
			},
			{
				name: "OWNER_X",
				description: "Owner only",
				contexts: ["general"],
				roleGate: { minRole: "OWNER" },
			},
		] as Action[];
		const catalog = collectDiscoveryCatalogActions({
			actions,
			message,
			selectedContexts: ["general"],
			userRoles: ["ADMIN"],
		});
		expect(catalog.map((action) => action.name)).toEqual(["MESSAGE", "VIEWS"]);
		let loaded: string[] = [];
		const discovery = createPlannerToolDiscoveryAction(catalog, (found) => {
			loaded = found.map((action) => action.name);
		});
		expect(discovery.description).toMatch(/^MESSAGE$/m);
		expect(discovery.description).not.toContain("PRIVATE_X");
		expect(discovery.description).not.toContain("OWNER_X");
		const result = await discovery.handler?.(runtime, message, undefined, {
			parameters: { names: ["MESSAGE"] },
		});
		expect(result?.success).toBe(true);
		expect(loaded).toEqual(["MESSAGE"]);
	});

	it("rejects a registered action using the reserved discovery protocol name", () => {
		expect(() =>
			createPlannerToolDiscoveryAction(
				[{ name: "DISCOVER_TOOLS", description: "Collision" }],
				() => undefined,
			),
		).toThrow("conflicts");
	});
});
