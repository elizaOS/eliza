/**
 * Defines the versioned semantic-stage envelope shared by trajectory storage,
 * exports, and viewer read contracts, adapting the richer runtime recorder
 * stages without creating a second stage vocabulary.
 */

import { ElizaError } from "../errors";
import type { RecordedStage } from "../runtime/trajectory-recorder";
import {
	RECORDED_STAGE_KINDS,
	type RecordedStageKind,
} from "../runtime/trajectory-stage-kind";
import type { JsonValue } from "../types/primitives";
import { asRecord } from "../utils/type-guards";
import { sanitizeTrajectoryJsonObject } from "./trajectory-json";

export const TRAJECTORY_SEMANTIC_STAGE_SCHEMA_VERSION = 1 as const;

export const TRAJECTORY_SEMANTIC_STAGES_MAX_ITEMS = 250;
const TRAJECTORY_SEMANTIC_STAGE_MAX_DEPTH = 20;
const TRAJECTORY_SEMANTIC_STAGE_MAX_NODES = 5_000;
const TRAJECTORY_SEMANTIC_STAGE_MAX_STRING_CHARS = 64 * 1024;
const TRAJECTORY_SEMANTIC_STAGE_MAX_ID_CHARS = 256;
const TRAJECTORY_SEMANTIC_STAGES_MAX_JSON_BYTES = 1024 * 1024;
const utf8Encoder = new TextEncoder();

const SEMANTIC_STAGE_KEYS = new Set([
	"schemaVersion",
	"stageId",
	"kind",
	"iteration",
	"retryIdx",
	"parentStageId",
	"startedAt",
	"endedAt",
	"latencyMs",
	"payload",
]);

const SEMANTIC_STAGE_PAYLOAD_KEYS = new Set([
	"model",
	"tool",
	"toolSearch",
	"evaluation",
	"cache",
	"factsAndRelationships",
]);

const RECORDED_STAGE_KIND_SET = new Set<string>(RECORDED_STAGE_KINDS);

/** A bounded, transport-safe semantic stage attached to a trajectory step. */
export interface TrajectorySemanticStageRecord {
	schemaVersion: typeof TRAJECTORY_SEMANTIC_STAGE_SCHEMA_VERSION;
	stageId: string;
	kind: RecordedStageKind;
	iteration?: number;
	retryIdx?: number;
	parentStageId?: string;
	startedAt: number;
	endedAt: number;
	latencyMs: number;
	payload: Record<string, JsonValue>;
}

function invalidSemanticStage(field: string, value?: unknown): ElizaError {
	return new ElizaError("Trajectory semantic stage is invalid", {
		code: "TRAJECTORY_SEMANTIC_STAGE_INVALID",
		context: {
			field,
			...(typeof value === "string" || typeof value === "number"
				? { value }
				: {}),
		},
	});
}

function hasOnlyKeys(
	record: Record<string, unknown>,
	allowed: ReadonlySet<string>,
): boolean {
	return Object.keys(record).every((key) => allowed.has(key));
}

function requiredStageId(value: unknown, field: string): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value !== value.trim() ||
		value.length > TRAJECTORY_SEMANTIC_STAGE_MAX_ID_CHARS
	) {
		throw invalidSemanticStage(field);
	}
	return value;
}

function requiredFiniteNumber(
	record: Record<string, unknown>,
	field: "startedAt" | "endedAt" | "latencyMs",
): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw invalidSemanticStage(field, value);
	}
	return value;
}

function optionalNonNegativeInteger(
	record: Record<string, unknown>,
	field: "iteration" | "retryIdx",
): number | undefined {
	const value = record[field];
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) < 0) {
		throw invalidSemanticStage(field, value);
	}
	return value as number;
}

function isJsonValue(
	value: unknown,
	state: {
		seen: WeakSet<object>;
		nodes: number;
		remainingBytes: number;
	},
	depth = 0,
): value is JsonValue {
	state.nodes += 1;
	if (
		state.nodes > TRAJECTORY_SEMANTIC_STAGE_MAX_NODES ||
		depth > TRAJECTORY_SEMANTIC_STAGE_MAX_DEPTH
	) {
		return false;
	}
	const serializedScalarBytes = (scalar: string | number | boolean | null) =>
		utf8Encoder.encode(JSON.stringify(scalar)).byteLength;
	if (value === null || typeof value === "boolean") {
		state.remainingBytes -= serializedScalarBytes(value);
		return state.remainingBytes >= 0;
	}
	if (typeof value === "string") {
		if (value.length > TRAJECTORY_SEMANTIC_STAGE_MAX_STRING_CHARS) return false;
		state.remainingBytes -= serializedScalarBytes(value);
		return state.remainingBytes >= 0;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return false;
		state.remainingBytes -= serializedScalarBytes(value);
		return state.remainingBytes >= 0;
	}
	if (typeof value !== "object") return false;
	if (state.seen.has(value)) return false;
	state.seen.add(value);
	if (Array.isArray(value)) {
		if (value.length > TRAJECTORY_SEMANTIC_STAGES_MAX_ITEMS) return false;
		const valid = value.every((entry) => isJsonValue(entry, state, depth + 1));
		state.seen.delete(value);
		return valid;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return false;
	const record = asRecord(value);
	if (!record || Object.keys(record).length > 200) return false;
	const valid = Object.entries(record).every(([key, entry]) => {
		state.remainingBytes -= serializedScalarBytes(key) + 1;
		return state.remainingBytes >= 0 && isJsonValue(entry, state, depth + 1);
	});
	state.seen.delete(value);
	return valid;
}

function createSemanticStageValidationState(): {
	seen: WeakSet<object>;
	nodes: number;
	remainingBytes: number;
} {
	return {
		seen: new WeakSet(),
		nodes: 0,
		remainingBytes: TRAJECTORY_SEMANTIC_STAGES_MAX_JSON_BYTES,
	};
}

/** Convert the established runtime recorder stage into the shared envelope. */
export function recordedStageToSemanticStage(
	stage: RecordedStage,
): TrajectorySemanticStageRecord {
	const payload = sanitizeTrajectoryJsonObject({
		...(stage.model ? { model: stage.model } : {}),
		...(stage.tool ? { tool: stage.tool } : {}),
		...(stage.toolSearch ? { toolSearch: stage.toolSearch } : {}),
		...(stage.evaluation ? { evaluation: stage.evaluation } : {}),
		...(stage.cache ? { cache: stage.cache } : {}),
		...(stage.factsAndRelationships
			? { factsAndRelationships: stage.factsAndRelationships }
			: {}),
	});
	if (!payload) throw invalidSemanticStage("payload");
	return parseTrajectorySemanticStage({
		schemaVersion: TRAJECTORY_SEMANTIC_STAGE_SCHEMA_VERSION,
		stageId: stage.stageId,
		kind: stage.kind,
		...(stage.iteration !== undefined ? { iteration: stage.iteration } : {}),
		...(stage.retryIdx !== undefined ? { retryIdx: stage.retryIdx } : {}),
		...(stage.parentStageId ? { parentStageId: stage.parentStageId } : {}),
		startedAt: stage.startedAt,
		endedAt: stage.endedAt,
		latencyMs: stage.latencyMs,
		payload,
	});
}

/** Convert runtime recorder stages while preserving their recorded order. */
export function recordedStagesToSemanticStages(
	stages: readonly RecordedStage[],
): TrajectorySemanticStageRecord[] {
	return (
		parseTrajectorySemanticStages(stages.map(recordedStageToSemanticStage)) ??
		[]
	);
}

/** Validate one untrusted persisted semantic-stage envelope. */
export function parseTrajectorySemanticStage(
	value: unknown,
): TrajectorySemanticStageRecord {
	return parseTrajectorySemanticStageWithState(
		value,
		createSemanticStageValidationState(),
	);
}

function parseTrajectorySemanticStageWithState(
	value: unknown,
	validationState: ReturnType<typeof createSemanticStageValidationState>,
): TrajectorySemanticStageRecord {
	const record = asRecord(value);
	if (!record) throw invalidSemanticStage("stage");
	if (!hasOnlyKeys(record, SEMANTIC_STAGE_KEYS)) {
		throw invalidSemanticStage("stage.keys");
	}
	if (record.schemaVersion !== TRAJECTORY_SEMANTIC_STAGE_SCHEMA_VERSION) {
		throw invalidSemanticStage("schemaVersion", record.schemaVersion);
	}
	const stageId = requiredStageId(record.stageId, "stageId");
	if (
		typeof record.kind !== "string" ||
		!RECORDED_STAGE_KIND_SET.has(record.kind)
	) {
		throw invalidSemanticStage("kind", record.kind);
	}
	const startedAt = requiredFiniteNumber(record, "startedAt");
	const endedAt = requiredFiniteNumber(record, "endedAt");
	const latencyMs = requiredFiniteNumber(record, "latencyMs");
	if (endedAt < startedAt) throw invalidSemanticStage("endedAt", endedAt);
	if (latencyMs !== endedAt - startedAt) {
		throw invalidSemanticStage("latencyMs", latencyMs);
	}
	const iteration = optionalNonNegativeInteger(record, "iteration");
	const retryIdx = optionalNonNegativeInteger(record, "retryIdx");
	const parentStageId = record.parentStageId;
	if (
		parentStageId !== undefined &&
		(typeof parentStageId !== "string" ||
			!parentStageId.trim() ||
			parentStageId !== parentStageId.trim() ||
			parentStageId === stageId ||
			parentStageId.length > TRAJECTORY_SEMANTIC_STAGE_MAX_ID_CHARS)
	) {
		throw invalidSemanticStage("parentStageId");
	}
	const payload = asRecord(record.payload);
	if (
		!payload ||
		!hasOnlyKeys(payload, SEMANTIC_STAGE_PAYLOAD_KEYS) ||
		!isJsonValue(payload, validationState)
	) {
		throw invalidSemanticStage("payload");
	}
	return {
		schemaVersion: TRAJECTORY_SEMANTIC_STAGE_SCHEMA_VERSION,
		stageId,
		kind: record.kind as RecordedStageKind,
		...(iteration !== undefined ? { iteration } : {}),
		...(retryIdx !== undefined ? { retryIdx } : {}),
		...(typeof parentStageId === "string" ? { parentStageId } : {}),
		startedAt,
		endedAt,
		latencyMs,
		payload: payload as Record<string, JsonValue>,
	};
}

/** Validate an optional untrusted array from a persisted trajectory step. */
export function parseTrajectorySemanticStages(
	value: unknown,
): TrajectorySemanticStageRecord[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) throw invalidSemanticStage("semanticStages");
	if (value.length > TRAJECTORY_SEMANTIC_STAGES_MAX_ITEMS) {
		throw invalidSemanticStage("semanticStages.length", value.length);
	}
	const validationState = createSemanticStageValidationState();
	const stageIds = new Set<string>();
	return value.map((stage) => {
		const parsed = parseTrajectorySemanticStageWithState(
			stage,
			validationState,
		);
		if (stageIds.has(parsed.stageId)) {
			throw invalidSemanticStage("stageId.duplicate", parsed.stageId);
		}
		stageIds.add(parsed.stageId);
		return parsed;
	});
}
