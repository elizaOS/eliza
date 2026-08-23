/**
 * Verifies persisted trust numbers fail closed before ordering or arithmetic.
 * The probes exercise the real component, database-row, and profile loading
 * boundaries while keeping storage deterministic and in-process.
 */

import { describe, expect, it } from "vitest";
import type { Component, IAgentRuntime, UUID } from "../../../types/index.ts";
import { TrustEvidenceType, type TrustProfile } from "../types/trust.ts";
import { TrustEngine } from "./TrustEngine.ts";

const EVALUATOR_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SUBJECT_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const SOURCE_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const COMPONENT_ID = "00000000-0000-0000-0000-000000000004" as UUID;

type TrustEngineProbe = {
	loadEvidence: (
		entityId: UUID,
		context: { evaluatorId: UUID },
	) => Promise<unknown[]>;
	analyzeTrend: (
		entityId: UUID,
		context: { evaluatorId: UUID },
		currentScore: number,
	) => Promise<unknown>;
};

function component(type: string, data: unknown): Component {
	return {
		id: COMPONENT_ID,
		type,
		agentId: EVALUATOR_ID,
		entityId: SUBJECT_ID,
		roomId: SUBJECT_ID,
		worldId: SUBJECT_ID,
		sourceEntityId: SOURCE_ID,
		data: data as never,
		createdAt: 1,
	};
}

function evidence(overrides: Record<string, unknown> = {}) {
	return {
		type: TrustEvidenceType.PROMISE_KEPT,
		timestamp: 1,
		impact: -10,
		weight: 0,
		description: "finite control",
		reportedBy: SOURCE_ID,
		verified: true,
		context: { evaluatorId: EVALUATOR_ID, timeWindow: { start: -1, end: 1 } },
		targetEntityId: SUBJECT_ID,
		evaluatorId: EVALUATOR_ID,
		...overrides,
	};
}

function profile(overrides: Partial<TrustProfile> = {}): TrustProfile {
	return {
		entityId: SUBJECT_ID,
		dimensions: {
			reliability: 0,
			competence: 1,
			integrity: 50,
			benevolence: 50,
			transparency: 50,
		},
		overallTrust: 0,
		confidence: 0,
		interactionCount: 0,
		evidence: [evidence() as never],
		lastCalculated: 0,
		calculationMethod: "finite-control",
		trend: { direction: "stable", changeRate: -1, lastChangeAt: 0 },
		evaluatorId: EVALUATOR_ID,
		...overrides,
	};
}

function runtimeWith(
	components: Component[],
	databaseRows: Array<Record<string, unknown>> = [],
): IAgentRuntime {
	const query = {
		from: () => query,
		where: () => query,
		orderBy: () => query,
		limit: async () => databaseRows,
	};
	return {
		agentId: EVALUATOR_ID,
		db: { select: () => query },
		getComponents: async () => components,
		reportError: () => undefined,
	} as unknown as IAgentRuntime;
}

async function probe(runtime: IAgentRuntime): Promise<TrustEngineProbe> {
	const engine = new TrustEngine();
	await engine.initialize(runtime);
	return engine as unknown as TrustEngineProbe;
}

function withNestedNumber(
	value: Record<string, unknown>,
	path: string,
	number: number,
): Record<string, unknown> {
	const copy = structuredClone(value);
	const parts = path.split(".");
	let target = copy;
	for (const part of parts.slice(0, -1)) {
		target = target[part] as Record<string, unknown>;
	}
	target[parts.at(-1) as string] = number;
	return copy;
}

const NON_FINITE_NUMBERS = [
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
];

describe("TrustEngine persisted numeric validation", () => {
	it.each([
		"timestamp",
		"impact",
		"weight",
		"context.timeWindow.start",
		"context.timeWindow.end",
	])("rejects non-finite component evidence field %s", async (field) => {
		for (const invalid of NON_FINITE_NUMBERS) {
			const stored = withNestedNumber(evidence(), field, invalid);
			const engine = await probe(
				runtimeWith([component("trust_evidence", stored)]),
			);
			await expect(
				engine.loadEvidence(SUBJECT_ID, { evaluatorId: EVALUATOR_ID }),
			).rejects.toMatchObject({ code: "INVALID_STORED_TRUST_EVIDENCE" });
		}
	});

	it.each(["timestamp", "impact", "weight"])(
		"rejects non-finite database evidence field %s",
		async (field) => {
			const baseRow = {
				timestamp: new Date(1),
				type: TrustEvidenceType.PROMISE_KEPT,
				impact: -10,
				weight: 0,
				description: "database control",
				sourceEntityId: SOURCE_ID,
				targetEntityId: SUBJECT_ID,
				evaluatorId: EVALUATOR_ID,
				verified: true,
				context: { evaluatorId: EVALUATOR_ID },
			};

			for (const invalid of NON_FINITE_NUMBERS) {
				const engine = await probe(
					runtimeWith([], [{ ...baseRow, [field]: invalid }]),
				);
				await expect(
					engine.loadEvidence(SUBJECT_ID, { evaluatorId: EVALUATOR_ID }),
				).rejects.toMatchObject({ code: "INVALID_STORED_TRUST_EVIDENCE" });
			}
		},
	);

	it("accepts finite zero and negative database evidence", async () => {
		const baseRow = {
			timestamp: new Date(1),
			type: TrustEvidenceType.PROMISE_KEPT,
			impact: -10,
			weight: 0,
			description: "database control",
			sourceEntityId: SOURCE_ID,
			targetEntityId: SUBJECT_ID,
			evaluatorId: EVALUATOR_ID,
			verified: true,
			context: { evaluatorId: EVALUATOR_ID },
		};

		const engine = await probe(runtimeWith([], [baseRow]));
		await expect(
			engine.loadEvidence(SUBJECT_ID, { evaluatorId: EVALUATOR_ID }),
		).resolves.toMatchObject([{ timestamp: 1, impact: -10, weight: 0 }]);
	});

	it.each([
		"dimensions.reliability",
		"dimensions.competence",
		"dimensions.integrity",
		"dimensions.benevolence",
		"dimensions.transparency",
		"overallTrust",
		"confidence",
		"interactionCount",
		"lastCalculated",
		"trend.changeRate",
		"trend.lastChangeAt",
		"evidence.0.weight",
	])("rejects non-finite stored profile field %s", async (field) => {
		for (const invalid of NON_FINITE_NUMBERS) {
			const stored = withNestedNumber(
				profile() as unknown as Record<string, unknown>,
				field,
				invalid,
			);
			const engine = await probe(
				runtimeWith([component("trust_profile", stored)]),
			);
			await expect(
				engine.analyzeTrend(SUBJECT_ID, { evaluatorId: EVALUATOR_ID }, 50),
			).rejects.toMatchObject({ code: "INVALID_STORED_TRUST_PROFILE" });
		}
	});

	it("accepts finite zero and negative values in stored profiles", async () => {
		const engine = await probe(
			runtimeWith([component("trust_profile", profile())]),
		);
		await expect(
			engine.analyzeTrend(SUBJECT_ID, { evaluatorId: EVALUATOR_ID }, 0),
		).resolves.toMatchObject({ direction: "stable" });
	});
});
