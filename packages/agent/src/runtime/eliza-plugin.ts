/**
 * Eliza plugin for elizaOS — workspace context, session keys, and agent
 * lifecycle actions (restart).
 *
 * Compaction is handled by core auto-compaction in the recent-messages provider.
 * Memory search/get actions are superseded by the todos plugin.
 */

import type { IAgentRuntime, Plugin, ServiceClass } from "@elizaos/core";
import { AgentEventService } from "@elizaos/core";
import { browserAutofillLoginAction } from "../actions/browser-autofill-login.js";
import { browserSessionAction } from "../actions/browser-session.js";
import { codeAction } from "../actions/code-umbrella.js";
import {
  disconnectConnectorAction,
  listConnectorsAction,
  saveConnectorConfigAction,
  toggleConnectorAction,
} from "../actions/connector-control.js";
import {
  executeDatabaseQueryAction,
  getTableDataAction,
  listDatabaseTablesAction,
  searchVectorsAction,
} from "../actions/database.js";
import {
  createContactAction,
  deleteContactAction,
  getRelationshipActivityAction,
  linkEntityAction,
  readEntityAction,
  resolveMergeCandidateAction,
  searchEntityAction,
  updateContactAction,
} from "../actions/entity-actions.js";
import { extractPageAction } from "../actions/extract-page.js";
import { launchpadLaunchAction } from "../actions/launchpad-launch.js";
import {
  clearLogsAction,
  exportLogsAction,
  queryLogsAction,
} from "../actions/logs.js";
import { manageTasksAction } from "../actions/manage-tasks.js";
import {
  createMemoryAction,
  editMemoryAction,
  forgetMemoryAction,
  recallMemoryFilteredAction,
} from "../actions/memories.js";
import { pageActionGroupActions } from "../actions/page-action-groups.js";
import { readChannelAction } from "../actions/read-channel.js";
import { readMessagesAction } from "../actions/read-messages.js";
import { readPluginConfigAction } from "../actions/read-plugin-config.js";
import { restartAction } from "../actions/restart.js";
import {
  describeRegisteredActionsAction,
  getRuntimeStatusAction,
  reloadRuntimeConfigAction,
  restartRuntimeAction,
} from "../actions/runtime.js";
import {
  scratchpadAddAction,
  scratchpadDeleteAction,
  scratchpadReadAction,
  scratchpadReplaceAction,
  scratchpadSearchAction,
} from "../actions/scratchpad.js";
import { searchConversationsAction } from "../actions/search-conversations.js";
import { sendAdminMessageAction } from "../actions/send-admin-message.js";
import { setUserNameAction } from "../actions/set-user-name.js";
import {
  toggleAutoTrainingAction,
  toggleCapabilityAction,
  updateAiProviderAction,
  updateIdentityAction,
} from "../actions/settings-actions.js";
import {
  addRegisteredSkillSlug,
  clearRegisteredSkillSlugs,
  skillCommandAction,
} from "../actions/skill-command.js";
import {
  archiveCodingTaskAction,
  reopenCodingTaskAction,
} from "../actions/tasks-coding.js";
import { terminalAction } from "../actions/terminal.js";
import {
  annotateTrajectoryAction,
  exportTrajectoryDatasetAction,
  queryTrajectoriesAction,
} from "../actions/trajectories.js";
import { updateOwnerNameAction } from "../actions/update-owner-name.js";
import { webSearchAction } from "../actions/web-search.js";
import {
  createWorkflowAction,
  deleteWorkflowAction,
  promoteTaskToWorkflowAction,
  toggleWorkflowActiveAction,
} from "../actions/workflow/index.js";
import { lateJoinWhitelistEvaluator } from "../evaluators/late-join-whitelist.js";
import { adminPanelProvider } from "../providers/admin-panel.js";
import { adminTrustProvider } from "../providers/admin-trust.js";
import { automationTerminalBridgeProvider } from "../providers/automation-terminal-bridge.js";
import { escalationTriggerProvider } from "../providers/escalation-trigger.js";
import { pageScopedContextProvider } from "../providers/page-scoped-context.js";
import { recentConversationsProvider } from "../providers/recent-conversations.js";
import { relevantConversationsProvider } from "../providers/relevant-conversations.js";
import { roleBackfillProvider } from "../providers/role-backfill.js";
import { rolodexProvider } from "../providers/rolodex.js";
import { createSessionKeyProvider } from "../providers/session-bridge.js";
import {
  getSessionProviders,
  resolveDefaultSessionStorePath,
} from "../providers/session-utils.js";
import { createChannelProfileProvider } from "../providers/simple-mode.js";
import { createDynamicSkillProvider } from "../providers/skill-provider.js";
import { createOngoingTasksProvider } from "../providers/tasks.js";
import { uiCatalogProvider } from "../providers/ui-catalog.js";
import { createUserNameProvider } from "../providers/user-name.js";
import { resolveDefaultAgentWorkspaceDir } from "../providers/workspace.js";
import { createWorkspaceProvider } from "../providers/workspace-provider.js";
import { ElizaCharacterPersistenceService } from "../services/character-persistence.js";
import { createTriggerTaskAction } from "../triggers/action.js";
import { deleteTriggerTaskAction } from "../triggers/delete-trigger.js";
import { runTriggerNowAction } from "../triggers/run-trigger.js";
import { registerTriggerTaskWorker } from "../triggers/runtime.js";
import { updateTriggerTaskAction } from "../triggers/update-trigger.js";

import { setCustomActionsRuntime } from "./custom-actions.js";

export type ElizaPluginConfig = {
  workspaceDir?: string;
  initMaxChars?: number;
  sessionStorePath?: string;
  agentId?: string;
};

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
          const skillsService = runtime.getService(
            "AGENT_SKILLS_SERVICE",
          ) as unknown as
            | {
                getLoadedSkills: () => Array<{
                  slug: string;
                  name: string;
                  description: string;
                }>;
              }
            | undefined;
          if (!skillsService) return false;

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

    evaluators: [lateJoinWhitelistEvaluator],

    actions: [
      restartAction,
      sendAdminMessageAction,
      terminalAction,
      createTriggerTaskAction,
      updateTriggerTaskAction,
      deleteTriggerTaskAction,
      runTriggerNowAction,
      createWorkflowAction,
      deleteWorkflowAction,
      toggleWorkflowActiveAction,
      promoteTaskToWorkflowAction,
      manageTasksAction,
      ...pageActionGroupActions,
      setUserNameAction,
      skillCommandAction,
      webSearchAction,
      extractPageAction,
      browserSessionAction,
      browserAutofillLoginAction,
      launchpadLaunchAction,
      readChannelAction,
      searchConversationsAction,
      searchEntityAction,
      linkEntityAction,
      readEntityAction,
      resolveMergeCandidateAction,
      getRelationshipActivityAction,
      createContactAction,
      updateContactAction,
      deleteContactAction,
      updateOwnerNameAction,
      readMessagesAction,
      updateIdentityAction,
      updateAiProviderAction,
      toggleCapabilityAction,
      toggleAutoTrainingAction,
      listConnectorsAction,
      toggleConnectorAction,
      saveConnectorConfigAction,
      disconnectConnectorAction,
      readPluginConfigAction,
      // Observability / introspection actions
      queryLogsAction,
      exportLogsAction,
      clearLogsAction,
      getRuntimeStatusAction,
      describeRegisteredActionsAction,
      reloadRuntimeConfigAction,
      restartRuntimeAction,
      listDatabaseTablesAction,
      getTableDataAction,
      executeDatabaseQueryAction,
      searchVectorsAction,
      queryTrajectoriesAction,
      exportTrajectoryDatasetAction,
      annotateTrajectoryAction,
      createMemoryAction,
      recallMemoryFilteredAction,
      forgetMemoryAction,
      editMemoryAction,
      scratchpadAddAction,
      scratchpadReadAction,
      scratchpadSearchAction,
      scratchpadReplaceAction,
      scratchpadDeleteAction,
      archiveCodingTaskAction,
      reopenCodingTaskAction,
      codeAction,
    ],
  };

  return plugin;
}
