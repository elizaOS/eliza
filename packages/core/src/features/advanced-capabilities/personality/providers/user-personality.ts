import { logger } from "../../../../logger.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../../types/index.ts";
import { MAX_PREFS_PER_USER, USER_PREFS_TABLE } from "../types.ts";

/**
 * Injects per-user interaction preferences into the prompt so the agent
 * adapts its style for each individual user without changing the global
 * character definition.
 */
export const userPersonalityProvider: Provider = {
	name: "userPersonalityPreferences",
	description:
		"Injects per-user interaction preferences into the prompt when responding to a specific user",
	dynamic: true,
	contexts: ["general", "agent_internal"],
	contextGate: { anyOf: ["general", "agent_internal"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		// Skip for agent's own messages (e.g. evolution evaluator)
		if (message.entityId === runtime.agentId) {
			return { text: "", values: {}, data: {} };
		}

		try {
			const preferences = await runtime.getMemories({
				entityId: message.entityId,
				roomId: runtime.agentId,
				tableName: USER_PREFS_TABLE,
				count: MAX_PREFS_PER_USER,
			});

			if (preferences.length === 0) {
				return { text: "", values: {}, data: {} };
			}

			const prefTexts = preferences
				.map((p) => p.content.text)
				.filter((t): t is string => typeof t === "string" && t.length > 0);

			if (prefTexts.length === 0) {
				return { text: "", values: {}, data: {} };
			}

			const contextText = [
				"[USER INTERACTION PREFERENCES]",
				"The following preferences apply ONLY when responding to THIS specific user:",
				...prefTexts.map((t, i) => `${i + 1}. ${t}`),
				"[/USER INTERACTION PREFERENCES]",
			].join("\n");

			logger.debug(
				{ userId: message.entityId, preferenceCount: prefTexts.length },
				"Injecting user personality preferences",
			);

			return {
				text: contextText,
				values: {
					userPreferenceCount: prefTexts.length,
					hasUserPreferences: true,
				},
				data: {
					preferences: prefTexts,
					userId: message.entityId,
				},
			};
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"Failed to load user personality preferences",
			);
			return { text: "", values: {}, data: {} };
		}
	},
};
