/**
 * Unit tests for `actions/to-tool`: converting an `Action`'s parameters into a
 * strict provider-native (function-calling) tool, expanding a Tier-A parent's
 * sub-actions into first-class planner tools, the core terminal tools, and the
 * HANDLE_RESPONSE tool description. Deterministic — hand-built actions, no live
 * model.
 */
import { describe, expect, it, vi } from "vitest";
import type {
	Action,
	ActionParameter,
	ActionParameterSchema,
} from "../../types";
import {
	actionToTool,
	buildPlannerToolsFromTieredActions,
	CORE_PLANNER_TERMINALS,
	createHandleResponseTool,
	HANDLE_RESPONSE_SCHEMA,
} from "../to-tool.ts";

function makeAction(overrides: Partial<Action>): Action {
	return {
		name: "TEST_ACTION",
		description: "Run the test action",
		handler: async () => undefined,
		validate: async () => true,
		...overrides,
	};
}

describe("actionToTool", () => {
	it("converts flat action parameters to a strict provider-native tool schema", () => {
		const modeParameter = {
			name: "mode",
			description: "Execution mode",
			required: false,
			options: [
				{ label: "Fast", value: "fast" },
				{ label: "Careful", value: "careful" },
			],
			schema: { type: "string", default: "fast" },
		} as ActionParameter & {
			options: Array<{ label: string; value: string }>;
		};
		const action = makeAction({
			name: "DOCUMENT",
			description: "Search indexed knowledge",
			descriptionCompressed: "Search knowledge",
			parameters: [
				{
					name: "query",
					description: "Search query",
					required: true,
					schema: { type: "string" },
				},
				{
					name: "limit",
					description: "Maximum number of results",
					descriptionCompressed: "Max results",
					examples: [1, 2, 3, 4, 5],
					required: false,
					schema: { type: "integer", minimum: 1, maximum: 20, default: 5 },
				},
				modeParameter,
			],
		});

		const tool = actionToTool(action);

		expect(tool).toEqual({
			type: "function",
			function: {
				name: "DOCUMENT",
				description: "Search indexed knowledge",
				strict: true,
				parameters: {
					type: "object",
					additionalProperties: false,
					required: ["query"],
					properties: {
						query: {
							type: "string",
							description: "Search query",
						},
						limit: {
							type: "integer",
							description: "Maximum number of results (e.g. 1, 2, 3, 4, 5)",
							minimum: 1,
							maximum: 20,
							default: 5,
						},
						mode: {
							type: "string",
							description: "Execution mode",
							enum: ["fast", "careful"],
							default: "fast",
						},
					},
				},
			},
		});
	});

	it("converts nested objects and arrays recursively", () => {
		const action = makeAction({
			name: "CREATE_TASK",
			description: "Create a task",
			parameters: [
				{
					name: "task",
					description: "Task payload",
					required: true,
					schema: {
						type: "object",
						properties: {
							title: {
								type: "string",
								required: true,
							} as ActionParameterSchema,
							metadata: {
								type: "object",
								properties: {
									priority: {
										type: "string",
										enum: ["low", "normal", "high"],
										default: "normal",
									},
								},
							},
							tags: { type: "array", items: { type: "string" } },
						},
					},
				},
			],
		});

		const schema = actionToTool(action).function.parameters;

		expect(schema.properties.task).toMatchObject({
			type: "object",
			additionalProperties: false,
			required: ["title"],
			properties: {
				title: { type: "string" },
				metadata: {
					type: "object",
					additionalProperties: false,
					required: [],
					properties: {
						priority: {
							type: "string",
							enum: ["low", "normal", "high"],
							default: "normal",
						},
					},
				},
				tags: { type: "array", items: { type: "string" } },
			},
		});
	});

	it("rejects names that are not strict native tool names", () => {
		expect(() => actionToTool(makeAction({ name: "searchDocuments" }))).toThrow(
			/Invalid tool name 'searchDocuments'/,
		);
		expect(() => actionToTool(makeAction({ name: "1_SEARCH" }))).toThrow(
			/must match/,
		);
	});
});

describe("buildPlannerToolsFromTieredActions", () => {
	function makeTieredAction(overrides: Partial<Action>): Action {
		return makeAction({
			parameters: [],
			...overrides,
		});
	}

	it("expands sub-actions of a Tier-A parent into first-class tools", () => {
		const playMusic = makeTieredAction({
			name: "PLAY_MUSIC",
			description: "Start playing a track.",
			parameters: [
				{
					name: "track",
					description: "Track id",
					required: true,
					schema: { type: "string" },
				},
			],
		});
		const pauseMusic = makeTieredAction({
			name: "PAUSE_MUSIC",
			description: "Pause the active track.",
		});
		const music = makeTieredAction({
			name: "MUSIC",
			description: "Music control parent action.",
			subActions: [playMusic, pauseMusic],
		});

		const tools = buildPlannerToolsFromTieredActions([music], {
			tierAParents: new Set(["MUSIC"]),
		});

		expect(tools.map((tool) => tool.name)).toEqual([
			"MUSIC",
			"PLAY_MUSIC",
			"PAUSE_MUSIC",
		]);
		// The expanded child carries its own parameter schema, not the parent's.
		const playTool = tools.find((tool) => tool.name === "PLAY_MUSIC");
		expect(
			(playTool?.parameters as { properties?: Record<string, unknown> })
				?.properties,
		).toMatchObject({ track: { type: "string" } });
	});

	it("expands sub-actions even when no tier metadata is provided", () => {
		const createTask = makeTieredAction({
			name: "CREATE_TASK",
			description: "Create a task.",
		});
		const lifeops = makeTieredAction({
			name: "LIFEOPS",
			description: "Life-ops umbrella parent.",
			subActions: [createTask],
		});

		const tools = buildPlannerToolsFromTieredActions([lifeops]);

		expect(tools.map((tool) => tool.name)).toEqual(["LIFEOPS", "CREATE_TASK"]);
	});

	it("ignores parent tier allow-lists and expands the complete child catalog", () => {
		const playMusic = makeTieredAction({
			name: "PLAY_MUSIC",
			description: "Start playing a track.",
		});
		const music = makeTieredAction({
			name: "MUSIC",
			description: "Music control parent action.",
			subActions: [playMusic],
		});
		const createTask = makeTieredAction({
			name: "CREATE_TASK",
			description: "Create a task.",
		});
		const lifeops = makeTieredAction({
			name: "LIFEOPS",
			description: "Life-ops umbrella parent.",
			subActions: [createTask],
		});

		const tools = buildPlannerToolsFromTieredActions([music, lifeops], {
			tierAParents: new Set(["MUSIC"]),
		});

		expect(tools.map((tool) => tool.name)).toEqual([
			"MUSIC",
			"PLAY_MUSIC",
			"LIFEOPS",
			"CREATE_TASK",
		]);
	});

	it("resolves string-only sub-action references via actionLookup", () => {
		const playMusic = makeTieredAction({
			name: "PLAY_MUSIC",
			description: "Start playing a track.",
		});
		const music = makeTieredAction({
			name: "MUSIC",
			description: "Music control parent action.",
			subActions: ["PLAY_MUSIC"],
		});

		const onUnresolved = vi.fn();
		const tools = buildPlannerToolsFromTieredActions([music], {
			tierAParents: new Set(["MUSIC"]),
			actionLookup: new Map([["PLAY_MUSIC", playMusic]]),
			onUnresolvedSubAction: onUnresolved,
		});

		expect(tools.map((tool) => tool.name)).toEqual(["MUSIC", "PLAY_MUSIC"]);
		expect(onUnresolved).not.toHaveBeenCalled();
	});

	it("skips unresolvable string sub-action references and reports them", () => {
		const music = makeTieredAction({
			name: "MUSIC",
			description: "Music control parent action.",
			subActions: ["PLAY_MUSIC", "PAUSE_MUSIC"],
		});

		const onUnresolved = vi.fn();
		const tools = buildPlannerToolsFromTieredActions([music], {
			tierAParents: ["MUSIC"],
			onUnresolvedSubAction: onUnresolved,
		});

		expect(tools.map((tool) => tool.name)).toEqual(["MUSIC"]);
		expect(onUnresolved).toHaveBeenCalledTimes(2);
		expect(onUnresolved).toHaveBeenCalledWith({
			parentName: "MUSIC",
			subActionName: "PLAY_MUSIC",
		});
		expect(onUnresolved).toHaveBeenCalledWith({
			parentName: "MUSIC",
			subActionName: "PAUSE_MUSIC",
		});
	});

	it("dedupes when a child appears both inline and under a Tier-A parent", () => {
		const playMusic = makeTieredAction({
			name: "PLAY_MUSIC",
			description: "Start playing a track.",
		});
		const music = makeTieredAction({
			name: "MUSIC",
			description: "Music control parent action.",
			subActions: [playMusic],
		});

		const tools = buildPlannerToolsFromTieredActions([music, playMusic], {
			tierAParents: new Set(["MUSIC"]),
		});

		// Even though PLAY_MUSIC is in the input list AND a sub-action of MUSIC,
		// it should appear once. Insertion order: MUSIC first, then PLAY_MUSIC
		// (emitted while expanding MUSIC's sub-actions — the second standalone
		// reference is deduped).
		expect(tools.map((tool) => tool.name)).toEqual(["MUSIC", "PLAY_MUSIC"]);
	});

	it("expands children when legacy tierAParents is omitted", () => {
		const playMusic = makeTieredAction({
			name: "PLAY_MUSIC",
			description: "Start playing a track.",
		});
		const music = makeTieredAction({
			name: "MUSIC",
			description: "Music control parent action.",
			subActions: [playMusic],
		});

		const tiered = buildPlannerToolsFromTieredActions([music, playMusic]);
		expect(tiered.map((tool) => tool.name)).toEqual(["MUSIC", "PLAY_MUSIC"]);
	});

	it("rejects sub-action names that are not strict native tool names", () => {
		const badChild = makeTieredAction({
			name: "lowercaseChild",
			description: "Invalid child.",
		});
		const parent = makeTieredAction({
			name: "PARENT",
			description: "Parent action.",
			subActions: [badChild],
		});

		expect(() =>
			buildPlannerToolsFromTieredActions([parent], {
				tierAParents: new Set(["PARENT"]),
			}),
		).toThrow("Failed to expand planner sub-action");
	});

	it("normalizes parent-name matching so Tier-A names case-fold against action names", () => {
		const playMusic = makeTieredAction({
			name: "PLAY_MUSIC",
			description: "Start playing a track.",
		});
		const music = makeTieredAction({
			name: "MUSIC",
			description: "Music control parent action.",
			subActions: [playMusic],
		});

		// Pass tierAParents as a plain array with mixed casing; the matcher should
		// still recognize 'MUSIC' as a tier-A parent.
		const tools = buildPlannerToolsFromTieredActions([music], {
			tierAParents: ["music"],
		});

		expect(tools.map((tool) => tool.name)).toEqual(["MUSIC", "PLAY_MUSIC"]);
	});

	it("ignores a legacy child allow-list and expands every child", () => {
		const playMusic = makeTieredAction({
			name: "PLAY_MUSIC",
			description: "Start playing a track.",
		});
		const pauseMusic = makeTieredAction({
			name: "PAUSE_MUSIC",
			description: "Pause the active track.",
		});
		const stopMusic = makeTieredAction({
			name: "STOP_MUSIC",
			description: "Stop playback.",
		});
		const music = makeTieredAction({
			name: "MUSIC",
			description: "Music control parent action.",
			subActions: [playMusic, pauseMusic, stopMusic],
		});

		const tools = buildPlannerToolsFromTieredActions([music], {
			tierAParents: new Set(["MUSIC"]),
			tierAChildrenByParent: { MUSIC: ["PLAY_MUSIC"] },
		});

		expect(tools.map((tool) => tool.name)).toEqual([
			"MUSIC",
			"PLAY_MUSIC",
			"PAUSE_MUSIC",
			"STOP_MUSIC",
		]);
	});

	it("expands all children even when a legacy allow-list entry is empty", () => {
		const playMusic = makeTieredAction({
			name: "PLAY_MUSIC",
			description: "Start playing a track.",
		});
		const music = makeTieredAction({
			name: "MUSIC",
			description: "Music control parent action.",
			subActions: [playMusic],
		});
		const createTask = makeTieredAction({
			name: "CREATE_TASK",
			description: "Create a task.",
		});
		const lifeops = makeTieredAction({
			name: "LIFEOPS",
			description: "Life-ops umbrella parent.",
			subActions: [createTask],
		});

		const tools = buildPlannerToolsFromTieredActions([music, lifeops], {
			tierAParents: new Set(["MUSIC", "LIFEOPS"]),
			tierAChildrenByParent: new Map([["LIFEOPS", []]]),
		});

		expect(tools.map((tool) => tool.name)).toEqual([
			"MUSIC",
			"PLAY_MUSIC",
			"LIFEOPS",
			"CREATE_TASK",
		]);
	});

	it("reports unresolved string refs even when a legacy allow-list omits them", () => {
		const onUnresolvedSubAction = vi.fn();
		const music = makeTieredAction({
			name: "MUSIC",
			description: "Music control parent action.",
			subActions: ["PLAY_MUSIC", "MISSING_CHILD"],
		});
		const playMusic = makeTieredAction({
			name: "PLAY_MUSIC",
			description: "Start playing a track.",
		});

		const tools = buildPlannerToolsFromTieredActions([music], {
			tierAParents: new Set(["MUSIC"]),
			actionLookup: new Map([["PLAY_MUSIC", playMusic]]),
			tierAChildrenByParent: { MUSIC: ["PLAY_MUSIC"] },
			onUnresolvedSubAction,
		});

		expect(tools.map((tool) => tool.name)).toEqual(["MUSIC", "PLAY_MUSIC"]);
		expect(onUnresolvedSubAction).toHaveBeenCalledWith({
			parentName: "MUSIC",
			subActionName: "MISSING_CHILD",
		});
	});

	it("emits parent terminals separately — does not implicitly append REPLY/IGNORE/STOP", () => {
		// The tiered builder is a pure transform over input actions; callers are
		// responsible for appending CORE_PLANNER_TERMINALS afterwards. This test
		// guards the canonical `tools = [...build(...), ...CORE_PLANNER_TERMINALS]`
		// shape from accidentally pulling terminals into the builder.
		const music = makeTieredAction({
			name: "MUSIC",
			description: "Music control parent action.",
		});

		const tools = buildPlannerToolsFromTieredActions([music]);

		expect(tools.map((tool) => tool.name)).toEqual(["MUSIC"]);
		// CORE_PLANNER_TERMINALS still exists separately and exposes REPLY/IGNORE/STOP.
		expect(CORE_PLANNER_TERMINALS.map((tool) => tool.name)).toEqual([
			"REPLY",
			"IGNORE",
			"STOP",
		]);
	});
});

describe("createHandleResponseTool descriptions", () => {
	it("mentions every schema-required field in both channel variants", () => {
		const required = HANDLE_RESPONSE_SCHEMA.required ?? [];
		expect(required).toContain("topics");

		const standard = createHandleResponseTool().description;
		const direct = createHandleResponseTool({
			directMessage: true,
		}).description;

		for (const field of required) {
			// The strict tool schema requires each of these fields, so the
			// instruction list in the description must tell the model to fill
			// them — including `topics` in the direct-message variant.
			expect(standard, `standard description missing '${field}'`).toContain(
				field,
			);
			expect(direct, `direct description missing '${field}'`).toContain(field);
		}
	});
});
