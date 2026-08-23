/**
 * Unit coverage for trust profile provider metadata, score classification,
 * interaction summaries, service boundaries, and explicit failure reporting.
 * The real provider runs against typed trust-service fakes without a model or database.
 */

import { describe, expect, test, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type {
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import type { TrustEngineServiceWrapper } from "../services/wrappers.ts";
import {
	TrustEvidenceType,
	type TrustInteraction,
	type TrustProfile,
} from "../types/trust.ts";
import { trustProfileProvider } from "./trustProfile.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const OTHER_ID = "00000000-0000-0000-0000-000000000004" as UUID;

const message: Memory = {
	agentId: AGENT_ID,
	entityId: ENTITY_ID,
	roomId: ROOM_ID,
	content: { text: "Show the trust profile" },
};

const state: State = { values: {}, data: {}, text: "" };

function profile(
	overallTrust: number,
	direction: TrustProfile["trend"]["direction"] = "stable",
): TrustProfile {
	return {
		entityId: ENTITY_ID,
		dimensions: {
			reliability: 81,
			competence: 72,
			integrity: 63,
			benevolence: 54,
			transparency: 45,
		},
		overallTrust,
		confidence: 0.9,
		interactionCount: 12,
		evidence: [],
		lastCalculated: 1,
		calculationMethod: "weighted-average",
		trend: { direction, changeRate: 2, lastChangeAt: 1 },
		evaluatorId: AGENT_ID,
	};
}

function interaction(impact: number): TrustInteraction {
	return {
		sourceEntityId: ENTITY_ID,
		targetEntityId: OTHER_ID,
		type: TrustEvidenceType.HELPFUL_ACTION,
		timestamp: 1,
		impact,
	};
}

function runtimeWithService(options?: {
	profile?: TrustProfile;
	interactions?: TrustInteraction[];
	failure?: unknown;
}) {
	const evaluateTrust = vi.fn(async () => {
		if (options && "failure" in options) throw options.failure;
		return options?.profile ?? profile(80);
	});
	const getRecentInteractions = vi.fn(async () => options?.interactions ?? []);
	const service = {
		trustEngine: { evaluateTrust },
		getRecentInteractions,
	} as Pick<TrustEngineServiceWrapper, "trustEngine" | "getRecentInteractions">;
	const reportError = vi.fn();
	const runtime = createMockRuntime({
		agentId: AGENT_ID,
		getService: (() => service) as IAgentRuntime["getService"],
		reportError,
	});

	return { runtime, evaluateTrust, getRecentInteractions, reportError };
}

describe("trustProfileProvider", () => {
	test("declares its dynamic admin/settings provider contract", () => {
		expect(trustProfileProvider).toMatchObject({
			name: "trustProfile",
			dynamic: true,
			contexts: ["admin", "settings"],
			contextGate: { anyOf: ["admin", "settings"] },
			cacheStable: false,
			cacheScope: "turn",
			roleGate: { minRole: "ADMIN" },
		});
	});

	test("returns an explicit result when the trust engine service is unavailable", async () => {
		const runtime = createMockRuntime({
			getService: (() => null) as IAgentRuntime["getService"],
		});

		await expect(
			trustProfileProvider.get(runtime, message, state),
		).resolves.toEqual({
			text: "Trust engine not available",
			values: {},
		});
	});

	test("returns an explicit result when evaluateTrust is unavailable", async () => {
		const service = { trustEngine: {} };
		const runtime = createMockRuntime({
			getService: (() => service) as IAgentRuntime["getService"],
		});

		await expect(
			trustProfileProvider.get(runtime, message, state),
		).resolves.toEqual({
			text: "Trust engine evaluateTrust not available",
			values: {},
		});
	});

	test.each([
		[80, "high trust"],
		[60, "good trust"],
		[40, "moderate trust"],
		[20, "low trust"],
		[19, "very low trust"],
	] as const)("classifies a score of %i as %s", async (score, trustLevel) => {
		const senderProfile = profile(score);
		const interactions = [interaction(4), interaction(0), interaction(-3)];
		const { runtime, evaluateTrust, getRecentInteractions } =
			runtimeWithService({
				profile: senderProfile,
				interactions,
			});

		await expect(
			trustProfileProvider.get(runtime, message, state),
		).resolves.toEqual({
			text: `The user has ${trustLevel} (${score}/100) with stable trust trend based on 12 interactions.`,
			values: {
				trustScore: score,
				trustLevel,
				trustTrend: "stable",
				reliability: 81,
				competence: 72,
				integrity: 63,
				benevolence: 54,
				transparency: 45,
				interactionCount: 12,
				recentPositiveActions: 1,
				recentNegativeActions: 1,
			},
			data: {
				profile: senderProfile,
				recentInteractions: interactions,
				truncated: false,
			},
		});
		expect(evaluateTrust).toHaveBeenCalledWith(ENTITY_ID, AGENT_ID, {
			roomId: ROOM_ID,
		});
		expect(getRecentInteractions).toHaveBeenCalledWith(ENTITY_ID, 7);
	});

	test.each([
		["increasing", "improving"],
		["decreasing", "declining"],
		["stable", "stable"],
	] as const)("renders a %s trend as %s", async (direction, renderedTrend) => {
		const { runtime } = runtimeWithService({ profile: profile(50, direction) });

		const result = await trustProfileProvider.get(runtime, message, state);

		expect(result.text).toBe(
			`The user has moderate trust (50/100) with ${renderedTrend} trust trend based on 12 interactions.`,
		);
		expect(result.values.trustTrend).toBe(direction);
	});

	test.each([
		[new Error("trust backend offline"), "trust backend offline"],
		["non-error rejection", "non-error rejection"],
	] as const)(
		"reports failures and serializes the unavailable result for %#",
		async (failure, expectedMessage) => {
			const { runtime, reportError, getRecentInteractions } =
				runtimeWithService({
					failure,
				});

			await expect(
				trustProfileProvider.get(runtime, message, state),
			).resolves.toEqual({
				text: "Unable to fetch trust profile",
				values: { trustProfileAvailable: false },
				data: { available: false, error: expectedMessage },
			});
			expect(reportError).toHaveBeenCalledWith(
				"TrustProfileProvider.get",
				failure,
				{ entityId: ENTITY_ID, roomId: ROOM_ID },
			);
			expect(getRecentInteractions).not.toHaveBeenCalled();
		},
	);
});
