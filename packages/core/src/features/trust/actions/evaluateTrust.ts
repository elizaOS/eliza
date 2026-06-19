import { logger } from "../../../logger.ts";
import type {
	ActionResult,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { parseJSONObjectFromText } from "../../../utils.ts";
import type { TrustEngineServiceWrapper } from "../services/wrappers.ts";
import type { TrustProfile } from "../types/trust.ts";

type ActionOptions = Record<string, unknown>;

function readNestedParameters(
	options: ActionOptions | undefined,
): ActionOptions {
	const nested = options?.parameters;
	if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) {
		return nested as ActionOptions;
	}
	return {};
}

export async function evaluateTrustHandler(
	runtime: IAgentRuntime,
	message: Memory,
	_state: State | undefined,
	options: ActionOptions | undefined,
): Promise<ActionResult> {
	const trustEngineService =
		runtime.getService<TrustEngineServiceWrapper>("trust-engine");

	if (!trustEngineService) {
		return {
			success: false,
			text: "Trust engine service is not available.",
			error: "Trust engine service not available",
			data: {
				actionName: "TRUST",
				subaction: "evaluate",
				reason: "trust_engine_unavailable",
			},
		};
	}

	const params = readNestedParameters(options);
	const text = message.content.text || "";
	let parsed: Record<string, unknown> | null = null;
	try {
		parsed = parseJSONObjectFromText(text);
	} catch {
		// Not JSON -- treat as plain text request
	}
	const requestData = { ...(parsed ?? {}), ...params } as {
		entityId?: string;
		entityName?: string;
		detailed?: boolean;
	};

	let targetEntityId: UUID | undefined;
	if (requestData.entityId) {
		targetEntityId = requestData.entityId as UUID;
	} else if (requestData.entityName) {
		return {
			success: false,
			text: "TRUST evaluate requires an entity ID for name-based requests. Please provide entityId.",
			error: "Entity ID required for name-based trust lookup",
			data: {
				actionName: "TRUST",
				subaction: "evaluate",
				entityName: requestData.entityName,
				reason: "entity_id_required",
			},
		};
	} else {
		targetEntityId = message.entityId;
	}

	try {
		const trustContext = {
			evaluatorId: runtime.agentId,
			roomId: message.roomId,
		};

		const trustProfile: TrustProfile =
			await trustEngineService.trustEngine.evaluateTrust(
				targetEntityId,
				runtime.agentId,
				trustContext,
			);

		const detailed = requestData.detailed ?? false;
		const cappedEvidence = Array.isArray(trustProfile.evidence)
			? trustProfile.evidence.slice(0, 20)
			: trustProfile.evidence;

		if (detailed) {
			const dimensionText = Object.entries(trustProfile.dimensions)
				.map(([dim, score]) => `- ${dim}: ${score}/100`)
				.join("\n");

			const trendText =
				trustProfile.trend.direction === "increasing"
					? `Increasing (+${trustProfile.trend.changeRate.toFixed(1)} pts/day)`
					: trustProfile.trend.direction === "decreasing"
						? `Decreasing (${trustProfile.trend.changeRate.toFixed(1)} pts/day)`
						: "Stable";

			return {
				success: true,
				text: `Trust Profile for ${targetEntityId}:

Overall Trust: ${trustProfile.overallTrust}/100
Confidence: ${(trustProfile.confidence * 100).toFixed(0)}%
Interactions: ${trustProfile.interactionCount}
Trend: ${trendText}

Trust Dimensions:
${dimensionText}

Last Updated: ${new Date(trustProfile.lastCalculated).toLocaleString()}`,
				data: {
					actionName: "TRUST",
					subaction: "evaluate",
					entityId: trustProfile.entityId,
					overallTrust: trustProfile.overallTrust,
					confidence: trustProfile.confidence,
					interactionCount: trustProfile.interactionCount,
					calculationMethod: trustProfile.calculationMethod,
					lastCalculated: trustProfile.lastCalculated,
					evaluatorId: trustProfile.evaluatorId,
					dimensions: trustProfile.dimensions,
					evidence: cappedEvidence,
					trend: trustProfile.trend,
				},
			};
		}

		const trustLevel =
			trustProfile.overallTrust >= 80
				? "High"
				: trustProfile.overallTrust >= 60
					? "Good"
					: trustProfile.overallTrust >= 40
						? "Moderate"
						: trustProfile.overallTrust >= 20
							? "Low"
							: "Very Low";

		return {
			success: true,
			text: `Trust Level: ${trustLevel} (${trustProfile.overallTrust}/100) based on ${trustProfile.interactionCount} interactions`,
			data: {
				actionName: "TRUST",
				subaction: "evaluate",
				trustScore: trustProfile.overallTrust,
				trustLevel,
				confidence: trustProfile.confidence,
			},
		};
	} catch (error) {
		logger.error({ error }, "[EvaluateTrust] Error evaluating trust:");
		return {
			success: false,
			text: "Failed to evaluate trust. Please try again.",
			error: error instanceof Error ? error.message : "Unknown error",
			data: { actionName: "TRUST", subaction: "evaluate" },
		};
	}
}
