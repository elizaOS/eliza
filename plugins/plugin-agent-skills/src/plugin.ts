/**
 * Agent Skills Plugin for elizaOS
 *
 * Provides seamless access to Agent Skills with:
 * - Progressive disclosure (metadata → instructions → resources)
 * - ClawHub registry integration for skill discovery
 * - Otto compatibility for dependency management
 * - Background catalog sync
 *
 * @see https://agentskills.io
 */

import type { Action, IAgentRuntime, Plugin, Provider } from "@elizaos/core";

// Actions
import { skillAction } from "./actions/skill";
import { useSkillAction } from "./actions/use-skill";
// Providers
import { enabledSkillsProvider } from "./providers/enabled-skills";
import {
	catalogAwarenessProvider,
	skillInstructionsProvider,
	skillsSummaryProvider,
} from "./providers/skills";
// Services
import { AgentSkillsService } from "./services/skills";

// Background task
import { startSyncTask } from "./tasks/sync-catalog";

type PluginServiceClass = NonNullable<Plugin["services"]>[number];

const ALL_SERVICES: PluginServiceClass[] = [
	AgentSkillsService as PluginServiceClass,
];

const ALL_ACTIONS: Action[] = [
	useSkillAction, // Canonical entry point — invoke an enabled skill by slug
	skillAction, // Catalog management: search/details/sync/toggle/install/uninstall
];

const ALL_PROVIDERS: Provider[] = [
	enabledSkillsProvider, // Canonical enabled-skills list for USE_SKILL planning
	skillsSummaryProvider, // Medium-res (default) - installed skills summary
	skillInstructionsProvider, // High-res - active skill instructions
	catalogAwarenessProvider, // Dynamic - catalog awareness
];

// Module-scoped handle to the background-task cleanup, set in `init` and
// invoked from `dispose` on plugin unload / runtime shutdown so the interval
// timer does not leak across reloads.
let cleanupSyncTask: (() => void) | null = null;

/**
 * Agent Skills Plugin
 *
 * ## Architecture:
 *
 * **Service (AgentSkillsService)**
 * - Discovers and loads skills from filesystem
 * - Validates skills against Agent Skills spec
 * - Manages registry integration (ClawHub)
 * - Supports Otto metadata extensions
 *
 * **Progressive Disclosure**
 * - Level 1 (Metadata): ~100 tokens per skill in system prompt
 * - Level 2 (Instructions): <5k tokens when skill triggers
 * - Level 3 (Resources): Unlimited, loaded on-demand
 *
 * **Providers**
 * - Summary: Installed skills with descriptions
 * - Instructions: Full body for contextually matched skills
 * - Catalog: Available skills when asking about capabilities
 *
 * **Actions**
 * - USE_SKILL: Canonical entry point for invoking an enabled skill
 * - SKILL: Search/details/sync/toggle/install/uninstall skill catalog ops
 *
 * ## Configuration:
 * - SKILLS_DIR: Skill directory (default: ./skills)
 * - SKILLS_AUTO_LOAD: Load on startup (default: true)
 * - SKILLS_REGISTRY: Registry URL (default: https://clawhub.ai)
 */
export const agentSkillsPlugin: Plugin = {
	name: "@elizaos/plugin-agent-skills",
	description:
		"Agent Skills - modular capabilities with progressive disclosure",

	services: ALL_SERVICES,
	actions: ALL_ACTIONS,
	providers: ALL_PROVIDERS,

	// Self-declared auto-enable: activate when features.agentSkills is enabled.
	autoEnable: {
		shouldEnable: (_env, config) => {
			const f = (config?.features as Record<string, unknown> | undefined)
				?.agentSkills;
			return (
				f === true ||
				(typeof f === "object" &&
					f !== null &&
					(f as { enabled?: unknown }).enabled !== false)
			);
		},
	},

	routes: [],

	// Initialize background task when plugin loads.
	// Note: the initial catalog sync happens eagerly inside
	// AgentSkillsService.initialize(). This background task only
	// handles periodic hourly refreshes.
	init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
		// If a previous runtime left a timer behind (e.g. reload in dev), clear
		// it before installing a fresh one so we never stack intervals.
		if (cleanupSyncTask) {
			cleanupSyncTask();
			cleanupSyncTask = null;
		}
		cleanupSyncTask = startSyncTask(runtime);

		// Log a startup summary so the operator can verify skills loaded
		const service = runtime.getService<AgentSkillsService>(
			"AGENT_SKILLS_SERVICE",
		);
		if (service) {
			const stats = service.getCatalogStats();
			runtime.logger.info(
				`AgentSkills: Ready — ${stats.loaded} skills loaded, ` +
					`${stats.total} in catalog (storage: ${stats.storageType})`,
			);
		}
	},

	// Clear the periodic sync-catalog timer when the runtime disposes this
	// plugin. Without this, the setInterval handle leaks across reloads.
	dispose: (_runtime: IAgentRuntime) => {
		if (cleanupSyncTask) {
			cleanupSyncTask();
			cleanupSyncTask = null;
		}
	},
};

export default agentSkillsPlugin;
