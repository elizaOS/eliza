/**
 * Eliza plugin for elizaOS — workspace context, session keys, and agent
 * lifecycle actions (restart).
 *
 * Compaction is handled by core auto-compaction in the recent-messages provider.
 * Memory search/get actions are superseded by plugin-clipboard.
 */

import type { IAgentRuntime, Plugin, ServiceClass } from "@elizaos/core";
import { AgentEventService } from "@elizaos/core";
import { launchAppAction, stopAppAction } from "../actions/app-control.js";
import { calendarAction } from "../actions/calendar.js";
import {
  readEntityAction,
  searchEntityAction,
} from "../actions/entity-actions.js";
import { gmailAction } from "../actions/gmail.js";
import { inboxAction } from "../actions/inbox.js";
import { lifeAction } from "../actions/life.js";
import { readChannelAction } from "../actions/read-channel.js";
import { restartAction } from "../actions/restart.js";
import { searchConversationsAction } from "../actions/search-conversations.js";
import { sendAdminMessageAction } from "../actions/send-admin-message.js";
import { setUserNameAction } from "../actions/set-user-name.js";
import {
  addRegisteredSkillSlug,
  clearRegisteredSkillSlugs,
  skillCommandAction,
} from "../actions/skill-command.js";
import { terminalAction } from "../actions/terminal.js";
import { updateOwnerProfileAction } from "../actions/update-owner-profile.js";
import { webSearchAction } from "../actions/web-search.js";
import {
  ensureProactiveAgentTask,
  registerProactiveTaskWorker,
} from "../activity-profile/proactive-worker.js";
import { lateJoinWhitelistEvaluator } from "../evaluators/late-join-whitelist.js";
import {
  ensureLifeOpsSchedulerTask,
  registerLifeOpsTaskWorker,
} from "../lifeops/runtime.js";
import { activityProfileProvider } from "../providers/activity-profile.js";
import { adminPanelProvider } from "../providers/admin-panel.js";
import { adminTrustProvider } from "../providers/admin-trust.js";
import { escalationTriggerProvider } from "../providers/escalation-trigger.js";
import { inboxTriageProvider } from "../providers/inbox-triage.js";
import { lifeOpsProvider } from "../providers/lifeops.js";
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
import { uiCatalogProvider } from "../providers/ui-catalog.js";
import { createUserNameProvider } from "../providers/user-name.js";
import { resolveDefaultAgentWorkspaceDir } from "../providers/workspace.js";
import { createWorkspaceProvider } from "../providers/workspace-provider.js";
import { ElizaCharacterPersistenceService } from "../services/character-persistence.js";
import { createTriggerTaskAction } from "../triggers/action.js";
import { registerTriggerTaskWorker } from "../triggers/runtime.js";
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
    lifeOpsProvider,
    activityProfileProvider,

    createSessionKeyProvider({ defaultAgentId: agentId }),
    ...getSessionProviders({ storePath: sessionStorePath }),
    createDynamicSkillProvider(),
    createUserNameProvider(),
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
      registerLifeOpsTaskWorker(runtime);
      setCustomActionsRuntime(runtime);
      const proactiveAgentDisabled = (() => {
        const disableValue = (
          process.env.ELIZA_DISABLE_PROACTIVE_AGENT ??
          process.env.ELIZA_DISABLE_PROACTIVE_AGENT ??
          ""
        )
          .trim()
          .toLowerCase();
        if (
          disableValue === "1" ||
          disableValue === "true" ||
          disableValue === "yes"
        ) {
          return true;
        }
        const enableValue = (process.env.ENABLE_PROACTIVE_AGENT ?? "")
          .trim()
          .toLowerCase();
        return enableValue === "0" || enableValue === "false";
      })();
      if (!proactiveAgentDisabled) {
        registerProactiveTaskWorker(runtime);
      } else {
        runtime.logger?.info(
          "[proactive] Proactive agent task skipped — ELIZA_DISABLE_PROACTIVE_AGENT=1",
        );
      }
      void (async () => {
        const DELAYS = [2_000, 5_000, 10_000];
        for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
          try {
            await ensureLifeOpsSchedulerTask(runtime);
            return;
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            if (attempt < DELAYS.length) {
              runtime.logger?.warn?.(
                `[lifeops] Scheduler task init failed (attempt ${attempt + 1}/${DELAYS.length + 1}), retrying in ${DELAYS[attempt]}ms: ${msg}`,
              );
              await new Promise((r) => setTimeout(r, DELAYS[attempt]));
            } else {
              runtime.logger?.error?.(
                `[lifeops] Scheduler task init failed after ${DELAYS.length + 1} attempts — LifeOps scheduler is NOT running: ${msg}`,
              );
            }
          }
        }
      })();
      if (!proactiveAgentDisabled) {
        void (async () => {
          const DELAYS = [2_000, 5_000, 10_000];
          for (let attempt = 0; attempt <= DELAYS.length; attempt++) {
            try {
              await ensureProactiveAgentTask(runtime);
              return;
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : String(error);
              if (attempt < DELAYS.length) {
                runtime.logger?.warn?.(
                  `[proactive] Task init failed (attempt ${attempt + 1}/${DELAYS.length + 1}), retrying in ${DELAYS[attempt]}ms: ${msg}`,
                );
                await new Promise((r) => setTimeout(r, DELAYS[attempt]));
              } else {
                runtime.logger?.error?.(
                  `[proactive] Task init failed after ${DELAYS.length + 1} attempts — proactive agent is NOT running: ${msg}`,
                );
              }
            }
          }
        })();
      }

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

      recentConversationsProvider,
      relevantConversationsProvider,
      rolodexProvider,

      uiCatalogProvider,
      roleBackfillProvider,
      escalationTriggerProvider,
      inboxTriageProvider,
    ],

    evaluators: [lateJoinWhitelistEvaluator],

    actions: [
      restartAction,
      launchAppAction,
      stopAppAction,
      sendAdminMessageAction,
      terminalAction,
      createTriggerTaskAction,
      calendarAction,
      gmailAction,
      lifeAction,
      setUserNameAction,
      updateOwnerProfileAction,
      skillCommandAction,
      webSearchAction,
      readChannelAction,
      searchConversationsAction,
      searchEntityAction,
      readEntityAction,
      inboxAction,
    ],
  };

  return plugin;
}
