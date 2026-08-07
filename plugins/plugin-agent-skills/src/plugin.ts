/**
 * Agent Skills Plugin for elizaOS
 *
 * Provides seamless access to Agent Skills with:
 * - Progressive disclosure (metadata → instructions → resources)
 * - Otto compatibility for dependency management
 *
 * @see https://agentskills.io
 */

import type { Action, Plugin, Provider } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";

// Actions
import { skillAction } from "./actions/skill";
import { useSkillAction } from "./actions/use-skill";
// Binance direct-skill dispatch (registered as a chat pre-handler)
import { binanceSkillPreHandler } from "./binance/pre-handler";
import { AgentSkillsPluginLifecycleService } from "./init";
// Providers
import { enabledSkillsProvider } from "./providers/enabled-skills";
import {
	skillInstructionsProvider,
	skillsSummaryProvider,
} from "./providers/skills";
// Services
import { AgentSkillsService } from "./services/skills";

type PluginServiceClass = NonNullable<Plugin["services"]>[number];

const ALL_SERVICES: PluginServiceClass[] = [
	AgentSkillsService as PluginServiceClass,
	AgentSkillsPluginLifecycleService as PluginServiceClass,
];

const ALL_ACTIONS: Action[] = [
	useSkillAction, // Canonical entry point — invoke an enabled skill by slug
	// SKILL is promoted: parent + virtual SKILL_<OP> actions per subaction.
	...promoteSubactionsToActions(skillAction),
];

const ALL_PROVIDERS: Provider[] = [
	enabledSkillsProvider, // Canonical enabled-skills list for USE_SKILL planning
	skillsSummaryProvider, // Medium-res (default) - installed skills summary
	skillInstructionsProvider, // High-res - active skill instructions
];

/**
 * Agent Skills Plugin
 *
 * ## Architecture:
 *
 * **Service (AgentSkillsService)**
 * - Discovers and loads skills from filesystem
 * - Validates skills against Agent Skills spec
 * - Installs skills directly from GitHub
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
 *
 * **Actions**
 * - USE_SKILL: Canonical entry point for invoking an enabled skill
 * - SKILL: Toggle/uninstall installed skills
 *
 * ## Configuration:
 * - SKILLS_DIR: Skill directory (default: ./skills)
 * - SKILLS_AUTO_LOAD: Load on startup (default: true)
 */
export const agentSkillsPlugin: Plugin = {
	name: "@elizaos/plugin-agent-skills",
	description:
		"Agent Skills - modular capabilities with progressive disclosure",
	dependencies: ["@elizaos/plugin-commands"],

	services: ALL_SERVICES,
	actions: ALL_ACTIONS,
	providers: ALL_PROVIDERS,

	// Direct dispatch for the Binance DeFi skill family: natural-language and
	// explicit triggers resolve the turn before the first response model call.
	chatPreHandlers: [binanceSkillPreHandler],

	// Self-declared auto-enable: activate when features.agentSkills is enabled.
	autoEnable: {
		shouldEnable: (_env, config) => {
			const f = (config.features as Record<string, unknown> | undefined)
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
};

export default agentSkillsPlugin;
