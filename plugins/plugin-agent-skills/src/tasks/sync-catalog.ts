/**
 * Background Catalog Sync Task
 *
 * Periodically syncs the skill catalog from the registry
 * to keep the agent aware of available skills.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";

/** Sync interval (1 hour) */
const SYNC_INTERVAL_MS = 1000 * 60 * 60;

/**
 * Background task that syncs the catalog periodically.
 */
export const syncCatalogTask = {
	name: "agent-skills-sync",
	description: "Sync skill catalog from registry",

	execute: async (runtime: IAgentRuntime): Promise<void> => {
		const service = runtime.getService<AgentSkillsService>(
			"AGENT_SKILLS_SERVICE",
		);
		if (!service) {
			runtime.logger.warn("AgentSkills: Sync task - service not available");
			return;
		}

		try {
			const result = await service.syncCatalog();
			runtime.logger.info(
				`AgentSkills: Catalog synced - ${result.updated} skills, ${result.added} new`,
			);
		} catch (error) {
			runtime.logger.error(`AgentSkills: Sync failed: ${error}`);
		}
	},
};

/**
 * Start the background sync task.
 * Returns a cleanup function to stop the task.
 *
 * Note: The initial catalog sync is performed eagerly during
 * AgentSkillsService.initialize(), so this task only handles
 * the periodic refresh (every hour).
 */
export function startSyncTask(runtime: IAgentRuntime): () => void {
	// Periodic sync only — initial sync is handled in service initialization
	const interval = setInterval(() => {
		syncCatalogTask.execute(runtime).catch((err) => {
			runtime.logger.error(`AgentSkills: Periodic sync failed: ${err}`);
		});
	}, SYNC_INTERVAL_MS);

	return () => {
		clearInterval(interval);
	};
}
