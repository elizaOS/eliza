/** Tests complete, permission-scoped schema loading without any live domain effects. */
import { describe, expect, it } from "vitest";
import { buildPlannerToolsFromActions } from "../../actions/to-tool";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import type { Action } from "../../types/components";
import type { Memory } from "../../types/memory";
import type { IAgentRuntime } from "../../types/runtime";
import { collectV5PlannerCandidateActions } from "./action-surface";
import {
	appendDiscoveredPlannerTools,
	createPlannerToolDiscoveryAction,
} from "./tool-discovery";

const runtime = {} as IAgentRuntime;
const message = {} as Memory;

describe("planner tool discovery", () => {
	it.each(["ADMIN", "USER"] as const)(
		"re-admits a requested domain with canonical gates for %s",
		async (role) => {
			const actualRuntime = new AgentRuntime({
				character: { name: "Discovery gates", bio: "test" },
				adapter: new InMemoryDatabaseAdapter(),
				logLevel: "fatal",
			});
			actualRuntime.actions.length = 0;
			const notes: Action = {
				name: "NOTES",
				description: "Owner notes",
				contexts: ["notes"],
				contextGate: { anyOf: ["notes"] },
				roleGate: { minRole: "ADMIN" },
				subActions: ["NOTES_READ"],
			};
			actualRuntime.actions.push(
				{ name: "CALENDAR", description: "Calendar", contexts: ["calendar"] },
				notes,
				{ ...notes, name: "NOTES_READ", subActions: undefined },
				{
					...notes,
					name: "PRIVATE_NOTES",
					private: true,
					subActions: undefined,
				},
				{
					...notes,
					name: "BLOCKED_NOTES",
					contextGate: { anyOf: ["notes"], noneOf: ["calendar"] },
					subActions: undefined,
				},
				{
					...notes,
					name: "DISABLED_NOTES",
					validate: async () => false,
					subActions: undefined,
				},
			);
			const turn = {
				id: "00000000-0000-4000-8000-000000000001",
				roomId: "00000000-0000-4000-8000-000000000002",
				entityId: "00000000-0000-4000-8000-000000000003",
				content: { text: "Discover the Notes family; keep Calendar visible." },
			} as Memory;
			const admit = (names: string[]) =>
				collectV5PlannerCandidateActions({
					runtime: actualRuntime,
					message: turn,
					state: { values: {}, data: {}, text: "" },
					selectedContexts: ["calendar"],
					candidateActions: names,
					userRoles: [role],
				});
			const initial = await admit([]);
			expect(initial.map((action) => action.name)).not.toContain("NOTES");
			let loaded: Action[] = [];
			const discovery = createPlannerToolDiscoveryAction(
				initial,
				(actions) => {
					loaded = actions;
				},
				admit,
			);
			const invoke = (names: string[]) =>
				discovery.handler?.(actualRuntime, turn, undefined, {
					parameters: { names },
				});
			expect((await invoke(["NOTES"]))?.success).toBe(role === "ADMIN");
			expect(loaded.map((action) => action.name)).toEqual(
				role === "ADMIN" ? ["NOTES", "NOTES_READ"] : [],
			);
			for (const name of [
				"PRIVATE_NOTES",
				"BLOCKED_NOTES",
				"DISABLED_NOTES",
				"NOT_REGISTERED",
			]) {
				loaded = [];
				expect((await invoke(["NOTES", name]))?.success).toBe(false);
				expect(loaded).toEqual([]);
			}
		},
	);

	it("adds discovered Notes schemas without expanding an existing Calendar umbrella", () => {
		const calendar: Action = {
			name: "CALENDAR",
			description: "Complete calendar umbrella",
			subActions: ["CALENDAR_CREATE"],
		};
		const current = buildPlannerToolsFromActions([calendar]);
		const before = structuredClone(current);
		const context = {
			id: "turn",
			events: [{ id: "calendar", type: "tool", tool: calendar }],
		} as import("../../types/context-object").ContextObject;
		const notes: Action[] = [
			{
				name: "NOTES",
				description: "All note operations",
				subActions: ["NOTES_LIST"],
			},
			{ name: "NOTES_LIST", description: "Complete notes list schema" },
		];
		appendDiscoveredPlannerTools(context, current, notes);
		expect(current.slice(0, before.length)).toEqual(before);
		expect(current.map((tool) => tool.name)).toContain("NOTES_LIST");
		expect(current.map((tool) => tool.name)).not.toContain("CALENDAR_CREATE");
		const once = JSON.stringify(current);
		appendDiscoveredPlannerTools(context, current, notes);
		expect(JSON.stringify(current)).toBe(once);
	});

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
