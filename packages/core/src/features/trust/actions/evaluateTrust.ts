import { logger } from "../../../logger.ts";
import type {
	ActionResult,
	Action as ElizaAction,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../utils/action-validation.ts";
import { parseJSONObjectFromText } from "../../../utils.ts";
import type { TrustEngineServiceWrapper } from "../services/wrappers.ts";
import type { TrustProfile } from "../types/trust.ts";
import { hasTrustEngine } from "./hasTrustEngine.ts";

export const evaluateTrustAction: ElizaAction = {
	name: "EVALUATE_TRUST",
	contexts: ["admin", "settings", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	description: "Evaluates the trust score and profile for a specified entity",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "entityId",
			description:
				"Optional target entity ID. Defaults to the sender entity ID.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "entityName",
			description:
				"Optional target entity name. EVALUATE_TRUST requires entityId for lookups; name-only requests return a bounded failure.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "detailed",
			description: "Whether to include detailed trust dimensions.",
			required: false,
			schema: { type: "boolean" as const, default: false },
		},
	],

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: Record<string, unknown>,
	): Promise<boolean> => {
		try {
			if (!hasTrustEngine(runtime)) return false;
			const params =
				options?.parameters && typeof options.parameters === "object"
					? (options.parameters as Record<string, unknown>)
					: {};
			const hasStructuredEntity =
				typeof params.entityId === "string" &&
				params.entityId.trim().length > 0;
			return (
				hasStructuredEntity ||
				hasActionContextOrKeyword(message, state, {
					contexts: ["admin", "settings", "agent_internal"],
					keywords: ["evaluate trust", "trust score", "trust profile"],
				})
			);
		} catch {
			return false;
		}
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state,
		_options,
		_callback,
	): Promise<ActionResult> => {
		const trustEngineService =
			runtime.getService<TrustEngineServiceWrapper>("trust-engine");

		if (!trustEngineService) {
			return {
				success: false,
				text: "Trust engine service is not available.",
				error: "Trust engine service not available",
				data: {
					actionName: "EVALUATE_TRUST",
					reason: "trust_engine_unavailable",
				},
			};
		}

		const params =
			_options?.parameters && typeof _options.parameters === "object"
				? (_options.parameters as Record<string, unknown>)
				: {};
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
				text: "EVALUATE_TRUST requires an entity ID for name-based requests. Please provide entityId.",
				error: "Entity ID required for name-based trust lookup",
				data: {
					actionName: "EVALUATE_TRUST",
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
						actionName: "EVALUATE_TRUST",
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
			} else {
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
						actionName: "EVALUATE_TRUST",
						trustScore: trustProfile.overallTrust,
						trustLevel,
						confidence: trustProfile.confidence,
					},
				};
			}
		} catch (error) {
			logger.error({ error }, "[EvaluateTrust] Error evaluating trust:");
			return {
				success: false,
				text: "Failed to evaluate trust. Please try again.",
				error: error instanceof Error ? error.message : "Unknown error",
				data: { actionName: "EVALUATE_TRUST" },
			};
		}
	},

	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "What is my trust score?",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Trust Level: Good (65/100) based on 42 interactions",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Show detailed trust profile for Alice",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: `Trust Profile for Alice:

Overall Trust: 78/100
Confidence: 85%
Interactions: 127
Trend: Increasing (+0.5 pts/day)

Trust Dimensions:
- reliability: 82/100
- competence: 75/100
- integrity: 80/100
- benevolence: 85/100
- transparency: 70/100

Last Updated: 12/20/2024, 3:45:00 PM`,
				},
			},
		],
	],

	similes: [
		"check trust score",
		"evaluate trust",
		"show trust level",
		"trust rating",
		"trust profile",
		"trust assessment",
		"check reputation",
		"show trust details",
	],
};
