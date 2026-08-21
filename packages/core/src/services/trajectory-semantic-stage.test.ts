/**
 * Exercises the semantic-stage adapter and strict persisted-envelope parser
 * with deterministic runtime-stage fixtures, including retrieval diagnostics.
 */

import { describe, expect, it } from "vitest";
import type { RecordedStage } from "../runtime/trajectory-recorder";
import { RECORDED_STAGE_KINDS } from "../runtime/trajectory-stage-kind";
import {
	parseTrajectorySemanticStage,
	parseTrajectorySemanticStages,
	recordedStageToSemanticStage,
} from "./trajectory-semantic-stage";

const toolSearchStage: RecordedStage = {
	stageId: "stage-tool-search-1",
	kind: "toolSearch",
	iteration: 1,
	startedAt: 1_000,
	endedAt: 1_012,
	latencyMs: 12,
	toolSearch: {
		query: {
			text: "schedule a workout",
			candidateActions: ["OWNER_ROUTINES", "VIEWS"],
			parentActionHints: ["OWNER_ROUTINES"],
		},
		results: [
			{ name: "OWNER_ROUTINES", score: 0.91, rank: 1, rrfScore: 0.031 },
			{ name: "VIEWS", score: 0.22, rank: 2, rrfScore: 0.016 },
		],
		tier: {
			tierA: ["OWNER_ROUTINES"],
			tierB: ["VIEWS"],
			omitted: 0,
		},
		durationMs: 12,
		fusedTopK: [{ actionName: "OWNER_ROUTINES", rrfScore: 0.031, rank: 1 }],
		selectedActions: ["OWNER_ROUTINES"],
	},
};

describe("trajectory semantic stages", () => {
	it("adapts the established runtime stage without losing candidates or ranks", () => {
		const semantic = recordedStageToSemanticStage(toolSearchStage);

		expect(semantic).toMatchObject({
			schemaVersion: 1,
			stageId: "stage-tool-search-1",
			kind: "toolSearch",
			iteration: 1,
			latencyMs: 12,
			payload: {
				toolSearch: {
					query: {
						candidateActions: ["OWNER_ROUTINES", "VIEWS"],
					},
					results: [
						{ name: "OWNER_ROUTINES", rank: 1 },
						{ name: "VIEWS", rank: 2 },
					],
					selectedActions: ["OWNER_ROUTINES"],
				},
			},
		});
	});

	it("round-trips a valid versioned envelope", () => {
		const semantic = recordedStageToSemanticStage(toolSearchStage);
		expect(
			parseTrajectorySemanticStage(JSON.parse(JSON.stringify(semantic))),
		).toEqual(semantic);
		expect(parseTrajectorySemanticStages([semantic])).toEqual([semantic]);
		expect(parseTrajectorySemanticStages(undefined)).toBeUndefined();
	});

	it("accepts every stage kind from the runtime's canonical vocabulary", () => {
		const semantic = recordedStageToSemanticStage(toolSearchStage);
		for (const kind of RECORDED_STAGE_KINDS) {
			expect(parseTrajectorySemanticStage({ ...semantic, kind }).kind).toBe(
				kind,
			);
		}
	});

	it.each([
		["unknown schema", { schemaVersion: 2 }],
		["unknown stage kind", { kind: "retrieval" }],
		["negative timing", { latencyMs: -1 }],
		["reversed timing", { endedAt: 999 }],
		["unknown envelope field", { unexpected: true }],
		["contradictory latency", { latencyMs: 11 }],
		["whitespace stage id", { stageId: " stage-tool-search-1" }],
		["self parent", { parentStageId: "stage-tool-search-1" }],
	])("rejects %s", (_label, patch) => {
		const semantic = recordedStageToSemanticStage(toolSearchStage);
		expect(() =>
			parseTrajectorySemanticStage({ ...semantic, ...patch }),
		).toThrow(/semantic stage is invalid/i);
	});

	it("rejects unknown, non-JSON, cyclic, and over-bounded payloads", () => {
		const semantic = recordedStageToSemanticStage(toolSearchStage);
		expect(() =>
			parseTrajectorySemanticStage({
				...semantic,
				payload: { retrieval: {} },
			}),
		).toThrow(/semantic stage is invalid/i);
		expect(() =>
			parseTrajectorySemanticStage({
				...semantic,
				payload: { toolSearch: { invalid: undefined } },
			}),
		).toThrow(/semantic stage is invalid/i);

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() =>
			parseTrajectorySemanticStage({
				...semantic,
				payload: { toolSearch: cyclic },
			}),
		).toThrow(/semantic stage is invalid/i);
		expect(() =>
			parseTrajectorySemanticStages(
				Array.from({ length: 251 }, () => semantic),
			),
		).toThrow(/semantic stage is invalid/i);
	});

	it("accepts a planner stage carrying a live-sized tool surface", () => {
		const semantic = recordedStageToSemanticStage(toolSearchStage);
		// ~80 tools × ~110 schema nodes: the shape a live planner stage records.
		const tools = Array.from({ length: 80 }, (_, index) => ({
			name: `TOOL_${index}`,
			description: "tool",
			parameters: {
				type: "object",
				properties: Object.fromEntries(
					Array.from({ length: 25 }, (_, field) => [
						`param${field}`,
						{ type: "string", description: "field" },
					]),
				),
				required: ["param0"],
			},
		}));
		const planner = {
			...semantic,
			stageId: "planner-1",
			payload: { model: { tools } },
		};
		expect(parseTrajectorySemanticStage(planner).stageId).toBe("planner-1");
		// A toolSearch query tokenizes the recent conversation too — hundreds
		// of entries on a busy room; the stage-count cap must not apply here.
		const tokens = Array.from({ length: 600 }, (_, index) => `tok${index}`);
		expect(
			parseTrajectorySemanticStage({
				...semantic,
				stageId: "search-1",
				payload: { toolSearch: { query: { tokens } } },
			}).stageId,
		).toBe("search-1");
		expect(
			parseTrajectorySemanticStages([
				planner,
				{ ...planner, stageId: "planner-2" },
				{ ...planner, stageId: "planner-3" },
			]),
		).toHaveLength(3);
	});

	it("applies node and byte budgets across the complete stage array", () => {
		const semantic = recordedStageToSemanticStage(toolSearchStage);
		expect(() =>
			parseTrajectorySemanticStages([
				{ ...semantic, stageId: "duplicate" },
				{ ...semantic, stageId: "duplicate" },
			]),
		).toThrow(/semantic stage is invalid/i);

		const largePayload = {
			model: Object.fromEntries(
				Array.from({ length: 10 }, (_, index) => [
					`field-${index}`,
					"x".repeat(60_000),
				]),
			),
		};
		expect(() =>
			parseTrajectorySemanticStages([
				{ ...semantic, stageId: "large-1", payload: largePayload },
				{ ...semantic, stageId: "large-2", payload: largePayload },
			]),
		).toThrow(/semantic stage is invalid/i);
	});
});
