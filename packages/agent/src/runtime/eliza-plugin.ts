/**
 * Eliza plugin for elizaOS — workspace context, session keys, and agent
 * lifecycle actions (restart).
 *
 * Compaction is handled by core auto-compaction in the recent-messages provider.
 * Memory search/get actions are superseded by the todos plugin.
 */

import type { IAgentRuntime, Plugin, ServiceClass } from "@elizaos/core";
import { AgentEventService, promoteSubactionsToActions } from "@elizaos/core";
import { contactAction } from "../actions/contact.ts";
import { databaseAction } from "../actions/database.ts";
import { logsAction } from "../actions/logs.ts";
import { memoryAction } from "../actions/memories.ts";
import { pageActionGroupActions } from "../actions/page-action-groups.ts";
import { pluginAction } from "../actions/plugin.ts";
import { runtimeAction } from "../actions/runtime.ts";
import { settingsAction } from "../actions/settings-actions.ts";
import {
  addRegisteredSkillSlug,
  clearRegisteredSkillSlugs,
} from "../actions/skill-command.ts";
import { terminalAction } from "../actions/terminal.ts";
import { triggerAction } from "../actions/trigger.ts";
import { adminPanelProvider } from "../providers/admin-panel.ts";
import { adminTrustProvider } from "../providers/admin-trust.ts";
import { automationTerminalBridgeProvider } from "../providers/automation-terminal-bridge.ts";
import { escalationTriggerProvider } from "../providers/escalation-trigger.ts";
import { pageScopedContextProvider } from "../providers/page-scoped-context.ts";
import { recentConversationsProvider } from "../providers/recent-conversations.ts";
import { relevantConversationsProvider } from "../providers/relevant-conversations.ts";
import { roleBackfillProvider } from "../providers/role-backfill.ts";
import { rolodexProvider } from "../providers/rolodex.ts";
import { createSessionKeyProvider } from "../providers/session-bridge.ts";
import {
  getSessionProviders,
  resolveDefaultSessionStorePath,
} from "../providers/session-utils.ts";
import { createChannelProfileProvider } from "../providers/simple-mode.ts";
import { createDynamicSkillProvider } from "../providers/skill-provider.ts";
import { createOngoingTasksProvider } from "../providers/tasks.ts";
import { uiCatalogProvider } from "../providers/ui-catalog.ts";
import { createUserNameProvider } from "../providers/user-name.ts";
import { createWorkspaceProvider } from "../providers/workspace-provider.ts";
import { ElizaCharacterPersistenceService } from "../services/character-persistence.ts";
import { AgentMediaGenerationService } from "../services/media-generation.ts";
import { PermissionRegistry } from "../services/permissions-registry.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";
import { registerTriggerTaskWorker } from "../triggers/runtime.ts";

import { setCustomActionsRuntime } from "./custom-actions.ts";

export type ElizaPluginConfig = {
  workspaceDir?: string;
  initMaxChars?: number;
  sessionStorePath?: string;
  agentId?: string;
};

type AgentSkillsService = {
  getLoadedSkills: () => Array<{
    slug: string;
    name: string;
    description: string;
  }>;
};

function isAgentSkillsService(value: unknown): value is AgentSkillsService {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { getLoadedSkills?: unknown }).getLoadedSkills ===
      "function"
  );
}

export function createElizaPlugin(config?: ElizaPluginConfig): Plugin {
  const workspaceDir =
    config?.workspaceDir ?? resolveDefaultAgentWorkspaceDir();
  const agentId = config?.agentId ?? "main";
  const sessionStorePath =
    config?.sessionStorePath ?? resolveDefaultSessionStorePath(agentId);

  const baseProviders = [
    createChannelProfileProvider(),
    createWorkspaceProvider({
      workspaceDir,
      maxCharsPerFile: config?.initMaxChars,
    }),
    adminTrustProvider,
    adminPanelProvider,

    createSessionKeyProvider({ defaultAgentId: agentId }),
    ...getSessionProviders({ storePath: sessionStorePath }),
    createDynamicSkillProvider(),
    createUserNameProvider(),
    createOngoingTasksProvider(),
  ];

  // PLAY_EMOTE lives in @elizaos/app-companion (emote catalog + action).

  const plugin: Plugin = {
    name: "eliza",
    description: "Eliza workspace context, session keys, and lifecycle actions",

    services: [
      AgentEventService as ServiceClass,
      ElizaCharacterPersistenceService as ServiceClass,
      AgentMediaGenerationService as ServiceClass,
      PermissionRegistry as ServiceClass,
    ],

    init: async (_pluginConfig, runtime: IAgentRuntime) => {
      registerTriggerTaskWorker(runtime);
      setCustomActionsRuntime(runtime);
      // Proactive agent (activity-profile) is now initialized by @elizaos/app-lifeops plugin init.

      // ── Auto-register skills as slash commands ───────────────────────
      // Runs after plugin-agent-skills init so getLoadedSkills() is populated.
      // Uses a deferred check because skill loading is async and may complete
      // after this init() returns.
      const registerSkillsAsCommands = () => {
        try {
          const skillsService = runtime.getService("AGENT_SKILLS_SERVICE");
          if (!isAgentSkillsService(skillsService)) return false;

          const skills = skillsService.getLoadedSkills();
          if (skills.length === 0) return false;

          // Dynamically import plugin-commands registry (may not be loaded)
          let registerCommand: (cmd: Record<string, unknown>) => void;
          let initForRuntime: (agentId: string) => void;
          try {
            const cmds = require("@elizaos/plugin-commands");
            registerCommand = cmds.registerCommand;
            initForRuntime = cmds.initForRuntime;
          } catch {
            return false; // plugin-commands not available
          }

          // Ensure the command store is scoped to this runtime
          initForRuntime(runtime.agentId);
          clearRegisteredSkillSlugs();

          let registered = 0;
          for (const skill of skills) {
            const slug = skill.slug.toLowerCase();
            try {
              registerCommand({
                key: `skill-${slug}`,
                description: skill.description.substring(0, 80),
                textAliases: [`/${slug}`],
                scope: "both",
                category: "skills",
                acceptsArgs: true,
                args: [
                  {
                    name: "input",
                    description: "Task or question for this skill",
                    captureRemaining: true,
                  },
                ],
              });
              addRegisteredSkillSlug(slug);
              registered++;
            } catch {
              // Command may already be registered (e.g. /stop conflicts)
            }
          }

          if (registered > 0) {
            const { logger } = require("@elizaos/core");
            logger.info(
              `[eliza] Registered ${registered} skills as slash commands`,
            );
          }
          return true;
        } catch {
          return false;
        }
      };

      // Try immediately, then retry after a delay for async skill loading
      if (!registerSkillsAsCommands()) {
        setTimeout(registerSkillsAsCommands, 5000);
      }
    },

    providers: [
      ...baseProviders,

      automationTerminalBridgeProvider,
      pageScopedContextProvider,
      recentConversationsProvider,
      relevantConversationsProvider,
      rolodexProvider,

      uiCatalogProvider,
      roleBackfillProvider,
      escalationTriggerProvider,
    ],

    actions: [
      terminalAction,
      ...promoteSubactionsToActions(triggerAction),
      ...pageActionGroupActions,
      ...promoteSubactionsToActions(contactAction),
      settingsAction,
      ...promoteSubactionsToActions(pluginAction),
      // Observability / introspection actions
      ...promoteSubactionsToActions(logsAction),
      ...promoteSubactionsToActions(runtimeAction),
      ...promoteSubactionsToActions(databaseAction),
      ...promoteSubactionsToActions(memoryAction),
      // SCHEDULE_FOLLOW_UP is now the `followup` op on contactAction.
      // ARCHIVE_CODING_TASK / REOPEN_CODING_TASK live as ops on the TASKS
      // parent in @elizaos/plugin-agent-orchestrator (also surfaced via the
      // CODE umbrella).
    ],
  };

  return plugin;
}
