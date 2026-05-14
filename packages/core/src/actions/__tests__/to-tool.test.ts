import { describe, expect, it, vi } from "vitest";
import type {
	Action,
	ActionParameter,
	ActionParameterSchema,
} from "../../types";
import {
	actionToTool,
	buildPlannerToolsFromActions,
	buildPlannerToolsFromTieredActions,
	CORE_PLANNER_TERMINALS,
	HANDLE_RESPONSE_DIRECT_LEGACY_REQUIRED_FIELDS,
	HANDLE_RESPONSE_DIRECT_SCHEMA,
	HANDLE_RESPONSE_LEGACY_REQUIRED_FIELDS,
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
				description: "Search knowledge",
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
							description: "Maximum number of results",
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

	it("deduplicates enum values before exposing action parameter schemas", () => {
		const action = makeAction({
			name: "DEDUP_ENUM",
			description: "Check enum output",
			parameters: [
				{
					name: "mode",
					description: "Execution mode",
					required: true,
					schema: {
						type: "string",
						enumValues: ["fast", "fast", "careful", "careful"],
					},
				},
			],
		});

		const tool = actionToTool(action);

		expect(tool.function.parameters.properties.mode.enum).toEqual([
			"fast",
			"careful",
		]);
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

describe("legacy HANDLE_RESPONSE schemas", () => {
	it("uses centralized required-field lists for the fallback schemas", () => {
		expect(HANDLE_RESPONSE_SCHEMA.required).toEqual([
			...HANDLE_RESPONSE_LEGACY_REQUIRED_FIELDS,
		]);
		expect(HANDLE_RESPONSE_DIRECT_SCHEMA.required).toEqual([
			...HANDLE_RESPONSE_DIRECT_LEGACY_REQUIRED_FIELDS,
		]);
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

	it("does not expand sub-actions for a Tier-B parent", () => {
		const createTask = makeTieredAction({
			name: "CREATE_TASK",
			description: "Create a task.",
		});
		const lifeops = makeTieredAction({
			name: "LIFEOPS",
			description: "Life-ops umbrella parent.",
			subActions: [createTask],
		});

		const tools = buildPlannerToolsFromTieredActions([lifeops], {
			// No tierAParents — LIFEOPS is implicitly Tier B.
		});

		expect(tools.map((tool) => tool.name)).toEqual(["LIFEOPS"]);
	});

	it("produces a correct combined tool list for mixed Tier A + Tier B parents", () => {
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
		]);
		// CREATE_TASK is gated behind the LIFEOPS parent handler — it does NOT
		// appear as a first-class tool.
		expect(tools.find((tool) => tool.name === "CREATE_TASK")).toBeUndefined();
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

	it("degrades to plain buildPlannerToolsFromActions behavior when tierAParents is empty", () => {
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
		const plain = buildPlannerToolsFromActions([music, playMusic]);

		expect(tiered.map((tool) => tool.name)).toEqual(
			plain.map((tool) => tool.name),
		);
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
		).toThrow(/Failed to expand sub-action 'lowercaseChild' of 'PARENT'/);
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
