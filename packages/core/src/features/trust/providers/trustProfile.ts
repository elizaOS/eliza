import { logger } from "../../../logger.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	State,
} from "../../../types/index.ts";
import type { TrustEngineServiceWrapper } from "../services/wrappers.ts";
import type { TrustInteraction } from "../types/trust.ts";

const MAX_TRUST_INTERACTIONS = 5;

export const trustProfileProvider: Provider = {
	name: "trustProfile",
	description:
		"Provides trust profile information for entities in the current context",

	dynamic: true,
	contexts: ["admin", "settings"],
	contextGate: { anyOf: ["admin", "settings"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "ADMIN" },

	get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
		try {
			const trustEngine = runtime.getService(
				"trust-engine",
			) as TrustEngineServiceWrapper;

			if (!trustEngine) {
				return {
					text: "Trust engine not available",
					values: {},
				};
			}
			if (!trustEngine.trustEngine.evaluateTrust) {
				return {
					text: "Trust engine evaluateTrust not available",
					values: {},
				};
			}

			const senderProfile = await trustEngine.trustEngine.evaluateTrust(
				message.entityId,
				runtime.agentId,
				{
					roomId: message.roomId,
				},
			);

			const recentInteractions = await trustEngine.getRecentInteractions(
				message.entityId,
				7,
			);
			const visibleRecentInteractions = recentInteractions.slice(
				0,
				MAX_TRUST_INTERACTIONS,
			);

			const trustLevel =
				senderProfile.overallTrust >= 80
					? "high trust"
					: senderProfile.overallTrust >= 60
						? "good trust"
						: senderProfile.overallTrust >= 40
							? "moderate trust"
							: senderProfile.overallTrust >= 20
								? "low trust"
								: "very low trust";

			const trendText =
				senderProfile.trend.direction === "increasing"
					? "improving"
					: senderProfile.trend.direction === "decreasing"
						? "declining"
						: "stable";

			return {
				text: `The user has ${trustLevel} (${senderProfile.overallTrust}/100) with ${trendText} trust trend based on ${senderProfile.interactionCount} interactions.`,
				values: {
					trustScore: senderProfile.overallTrust,
					trustLevel,
					trustTrend: senderProfile.trend.direction,
					reliability: senderProfile.dimensions.reliability,
					competence: senderProfile.dimensions.competence,
					integrity: senderProfile.dimensions.integrity,
					benevolence: senderProfile.dimensions.benevolence,
					transparency: senderProfile.dimensions.transparency,
					interactionCount: senderProfile.interactionCount,
					recentPositiveActions: recentInteractions.filter(
						(i: TrustInteraction) => i.impact > 0,
					).length,
					recentNegativeActions: recentInteractions.filter(
						(i: TrustInteraction) => i.impact < 0,
					).length,
				},
				data: {
					profile: senderProfile,
					recentInteractions: visibleRecentInteractions,
					truncated:
						recentInteractions.length > visibleRecentInteractions.length,
				},
			};
		} catch (error) {
			logger.error(
				{ error },
				"[TrustProfileProvider] Error fetching trust profile:",
			);
			return {
				text: "Unable to fetch trust profile",
				values: {},
				data: {
					error: error instanceof Error ? error.message : String(error),
				},
			};
		}
	},
};
