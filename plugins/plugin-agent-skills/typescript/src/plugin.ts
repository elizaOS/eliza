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

import type {
  Plugin,
  Action,
  Provider,
  IAgentRuntime,
  ServiceClass,
} from "@elizaos/core";

// Services
import { AgentSkillsService } from "./services/skills";

// Actions
import { searchSkillsAction } from "./actions/search-skills";
import { getSkillDetailsAction } from "./actions/get-skill-details";
import { getSkillGuidanceAction } from "./actions/get-skill-guidance";
import { syncCatalogAction } from "./actions/sync-catalog";
import { runSkillScriptAction } from "./actions/run-skill-script";

// Providers
import {
  skillsOverviewProvider,
  skillsSummaryProvider,
  skillInstructionsProvider,
  catalogAwarenessProvider,
} from "./providers/skills";

// Background task
import { startSyncTask } from "./tasks/sync-catalog";

const ALL_SERVICES: ServiceClass[] = [
  AgentSkillsService as unknown as ServiceClass,
];

const ALL_ACTIONS: Action[] = [
  searchSkillsAction, // Browse/search available skills
  getSkillDetailsAction, // Get info about a specific skill
  getSkillGuidanceAction, // Auto-finds, installs, returns skill instructions
  syncCatalogAction, // Manual catalog sync
  runSkillScriptAction, // Execute scripts from installed skills
];

const ALL_PROVIDERS: Provider[] = [
  skillsSummaryProvider, // Medium-res (default) - installed skills
  skillInstructionsProvider, // High-res - active skill instructions
  catalogAwarenessProvider, // Dynamic - catalog awareness
];

// Track cleanup function for background task
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
 * - GET_SKILL_GUIDANCE: Main action - find, install, return instructions
 * - SEARCH_SKILLS: Browse available skills
 * - GET_SKILL_DETAILS: Get detailed skill info
 * - RUN_SKILL_SCRIPT: Execute bundled scripts
 * - SYNC_SKILL_CATALOG: Refresh catalog
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

  evaluators: [],
  routes: [],

  // Initialize background task when plugin loads
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    cleanupSyncTask = startSyncTask(runtime);
    runtime.logger.info("AgentSkills: Background sync task started");
  },
};

// Legacy exports for backwards compatibility
export const clawHubPlugin = agentSkillsPlugin;

export default agentSkillsPlugin;
