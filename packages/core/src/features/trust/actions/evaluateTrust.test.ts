/**
 * TRUST evaluate action tests for complete detailed evidence projection.
 */

import { describe, expect, it, vi } from "vitest";
import { TrustEvidenceType } from "../types/trust.ts";
import { evaluateTrustHandler } from "./evaluateTrust.ts";

describe("TRUST evaluate", () => {
	it("returns every evidence record in a detailed result", async () => {
		const evidence = Array.from({ length: 30 }, (_, index) => ({
			type: TrustEvidenceType.HELPFUL_ACTION,
			timestamp: index,
			impact: 1,
			weight: 1,
			description: `Evidence ${index}`,
			reportedBy: "reporter-id",
			verified: true,
			context: { evaluatorId: "evaluator-id" },
			targetEntityId: "target-id",
			evaluatorId: "evaluator-id",
		}));
		const evaluateTrust = vi.fn(async () => ({
			entityId: "target-id",
			dimensions: {
				reliability: 80,
				competence: 80,
				integrity: 80,
				benevolence: 80,
				transparency: 80,
			},
			overallTrust: 80,
			confidence: 1,
			interactionCount: 30,
			evidence,
			lastCalculated: 0,
			calculationMethod: "test",
			trend: { direction: "stable", changeRate: 0, lastChangeAt: 0 },
			evaluatorId: "evaluator-id",
		}));
		const runtime = {
			agentId: "agent-id",
			getService: vi.fn(() => ({ trustEngine: { evaluateTrust } })),
		};

		const result = await evaluateTrustHandler(
			runtime as never,
			{
				entityId: "requester-id",
				roomId: "room-id",
				content: { text: "" },
			} as never,
			undefined,
			{ parameters: { entityId: "target-id", detailed: true } },
		);

		expect(result).toMatchObject({
			success: true,
			data: { evidence },
		});
	});
});
