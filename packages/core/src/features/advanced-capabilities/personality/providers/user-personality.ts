import { logger } from "../../../../logger.ts";
import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../../types/index.ts";
import { getPersonalityStore } from "../services/personality-store.ts";
import {
	MAX_PREFS_PER_USER,
	type PersonalitySlot,
	USER_PREFS_TABLE,
} from "../types.ts";

function renderSlot(
	slot: PersonalitySlot,
	header: string,
	footer: string,
): string | null {
	const lines: string[] = [];
	if (slot.verbosity) lines.push(`- verbosity: ${slot.verbosity}`);
	if (slot.tone) lines.push(`- tone: ${slot.tone}`);
	if (slot.formality) lines.push(`- formality: ${slot.formality}`);
	if (slot.reply_gate && slot.reply_gate !== "always") {
		lines.push(`- reply_gate: ${slot.reply_gate}`);
	}
	if (slot.custom_directives.length > 0) {
		lines.push("- custom directives:");
		slot.custom_directives.forEach((directive, index) => {
			lines.push(`  ${index + 1}. ${directive}`);
		});
	}
	if (lines.length === 0) return null;
	return [header, ...lines, footer].join("\n");
}

/**
 * Injects per-user interaction preferences (structured slot + legacy free-text)
 * so the agent adapts its style for each individual user without changing the
 * global character definition.
 *
 * Resolution rule: GLOBAL slot is rendered first (lower precedence in the
 * model's eye), then USER slot. When both set the same trait, the user's
 * value wins because it appears later in the prompt and is labeled as
 * applying to THIS user.
 */
export const userPersonalityProvider: Provider = {
	name: "userPersonalityPreferences",
	description:
		"Injects per-user and global structured personality slots plus any legacy free-text preferences",
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

		const blocks: string[] = [];
		const store = getPersonalityStore(runtime);

		if (store) {
			const globalSlot = store.getSlot("global");
			const globalBlock = renderSlot(
				globalSlot,
				"[GLOBAL PERSONALITY]",
				"[/GLOBAL PERSONALITY]",
			);
			if (globalBlock) blocks.push(globalBlock);

			const userSlot = store.getSlot(message.entityId);
			const userBlock = renderSlot(
				userSlot,
				"[PERSONALITY for THIS user]",
				"[/PERSONALITY for THIS user]",
			);
			if (userBlock) blocks.push(userBlock);
		}

		// Legacy free-text preferences (kept for backward compatibility).
		let legacyCount = 0;
		try {
			const preferences = await runtime.getMemories({
				entityId: message.entityId,
				roomId: runtime.agentId,
				tableName: USER_PREFS_TABLE,
				count: MAX_PREFS_PER_USER,
			});
			const prefTexts = preferences
				.map((p) => p.content.text)
				.filter((t): t is string => typeof t === "string" && t.length > 0);
			if (prefTexts.length > 0) {
				legacyCount = prefTexts.length;
				blocks.push(
					[
						"[USER INTERACTION PREFERENCES]",
						"The following preferences apply ONLY when responding to THIS specific user:",
						...prefTexts.map((t, i) => `${i + 1}. ${t}`),
						"[/USER INTERACTION PREFERENCES]",
					].join("\n"),
				);
			}
		} catch (error) {
			logger.warn(
				{ error: error instanceof Error ? error.message : String(error) },
				"Failed to load legacy user personality preferences",
			);
		}

		if (blocks.length === 0) {
			return { text: "", values: {}, data: {} };
		}

		const contextText = blocks.join("\n\n");
		return {
			text: contextText,
			values: {
				hasUserPreferences: true,
				userPreferenceCount: legacyCount,
			},
			data: {
				userId: message.entityId,
			},
		};
	},
};
