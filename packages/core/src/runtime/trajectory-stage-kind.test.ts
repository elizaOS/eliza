/**
 * Verifies the canonical recorded stage-kind vocabulary through its real
 * consumers: the runtime recorder re-export must stay the single shared array
 * instance, every declared kind must convert through the semantic-stage
 * adapter and pass the persisted-envelope validator, and values outside the
 * vocabulary must be rejected with the typed kind error instead of being
 * normalized. Deterministic — plain fixtures, no mocks, no live runtime.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../errors";
import {
	parseTrajectorySemanticStage,
	parseTrajectorySemanticStages,
	recordedStageToSemanticStage,
} from "../services/trajectory-semantic-stage";
import type { RecordedStage } from "./trajectory-recorder";
import { RECORDED_STAGE_KINDS as RECORDED_STAGE_KINDS_VIA_RECORDER } from "./trajectory-recorder";
import {
	RECORDED_STAGE_KINDS,
	type RecordedStageKind,
} from "./trajectory-stage-kind";

const envelopeForKind = (kind: RecordedStageKind) => ({
	schemaVersion: 1,
	stageId: `stage-${kind}`,
	kind,
	startedAt: 1_000,
	endedAt: 1_012,
	latencyMs: 12,
	payload: {},
});

const recordedStageOfKind = (kind: RecordedStageKind): RecordedStage => ({
	stageId: `stage-${kind}`,
	kind,
	iteration: 2,
	startedAt: 1_000,
	endedAt: 1_012,
	latencyMs: 12,
});

const parseWithKind = (kindValue: unknown): ElizaError => {
	try {
		parseTrajectorySemanticStage({
			...envelopeForKind("planner"),
			kind: kindValue,
		});
	} catch (error) {
		if (error instanceof ElizaError) return error;
		throw error;
	}
	throw new Error(`expected kind ${JSON.stringify(kindValue)} to be rejected`);
};

describe("RECORDED_STAGE_KINDS vocabulary", () => {
	it("is exported by the runtime recorder as the same single array instance", () => {
		expect(RECORDED_STAGE_KINDS_VIA_RECORDER).toBe(RECORDED_STAGE_KINDS);
	});

	it("admits every declared kind through the persisted-envelope validator", () => {
		for (const kind of RECORDED_STAGE_KINDS) {
			const parsed = parseTrajectorySemanticStage(envelopeForKind(kind));
			expect(parsed.kind).toBe(kind);
			expect(parsed.schemaVersion).toBe(1);
			expect(parsed.payload).toEqual({});
		}
	});

	it("converts a recorded producer stage for every declared kind", () => {
		for (const kind of RECORDED_STAGE_KINDS) {
			const semantic = recordedStageToSemanticStage(recordedStageOfKind(kind));
			expect(semantic.kind).toBe(kind);
			expect(semantic.iteration).toBe(2);
			expect(semantic.payload).toEqual({});
			expect(
				parseTrajectorySemanticStage(JSON.parse(JSON.stringify(semantic))),
			).toEqual(semantic);
		}
	});

	it("accepts the complete vocabulary as one ordered batch", () => {
		const stages = RECORDED_STAGE_KINDS.map((kind, index) => ({
			...envelopeForKind(kind),
			stageId: `stage-${index}-${kind}`,
		}));
		const parsed = parseTrajectorySemanticStages(stages);
		expect(parsed?.map((stage) => stage.kind)).toEqual([
			...RECORDED_STAGE_KINDS,
		]);
		const stageIds = parsed?.map((stage) => stage.stageId) ?? [];
		expect(new Set(stageIds).size).toBe(RECORDED_STAGE_KINDS.length);
	});

	it.each([
		["empty string", ""],
		["case-flipped member", "MessageHandler"],
		["uppercased member", "PLANNER"],
		["leading whitespace", " planner"],
		["trailing whitespace", "planner "],
		["punctuated member", "tool!"],
		["former or imagined kind", "retrieval"],
		["newline-suffixed member", "messageHandler\n"],
	])("rejects %s without normalizing it into a member", (_label, kindValue) => {
		const error = parseWithKind(kindValue);
		expect(error.code).toBe("TRAJECTORY_SEMANTIC_STAGE_INVALID");
		expect(error.name).toBe("ElizaError");
		expect(error.context?.field).toBe("kind");
		expect(error.context?.value).toBe(kindValue);
	});

	it.each([
		["a number", 42],
		["null", null],
		["undefined", undefined],
		["boolean", true],
		["array of members", ["messageHandler"]],
		["plain object", { kind: "planner" }],
	])("rejects a non-string kind (%s)", (_label, kindValue) => {
		const error = parseWithKind(kindValue);
		expect(error.code).toBe("TRAJECTORY_SEMANTIC_STAGE_INVALID");
		expect(error.context?.field).toBe("kind");
		if (typeof kindValue === "number") {
			expect(error.context?.value).toBe(kindValue);
		} else {
			expect(error.context?.value).toBeUndefined();
		}
	});
});
