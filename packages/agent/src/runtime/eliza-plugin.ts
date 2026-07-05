/**
 * Eliza plugin for elizaOS — workspace context, session keys, and agent
 * lifecycle actions (restart).
 *
 * Compaction is handled by core auto-compaction in the recent-messages provider.
 * Memory search/get actions are superseded by the todos plugin.
 */

import type {
  CommandRegistryService,
  IAgentRuntime,
  Plugin,
  ServiceClass,
} from "@elizaos/core";
import {
  AgentEventService,
  logger,
  NotificationService,
  promoteSubactionsToActions,
} from "@elizaos/core";
import { compactConversationAction } from "../actions/compact-conversation.ts";
import { connectAccountAction } from "../actions/connect-account.ts";
import { contactAction } from "../actions/contact.ts";
import { databaseAction } from "../actions/database.ts";
import { filesAction } from "../actions/files.ts";
import { knowledgeActions } from "../actions/knowledge.ts";
import { logsAction } from "../actions/logs.ts";
import { memoryAction } from "../actions/memories.ts";
import { notifyAction } from "../actions/notify.ts";
import { pageDelegateAction } from "../actions/page-action-groups.ts";
import { pluginAction } from "../actions/plugin.ts";
import { runtimeAction } from "../actions/runtime.ts";
import { settingsAction } from "../actions/settings-actions.ts";
import { terminalAction } from "../actions/terminal.ts";
import { triggerAction } from "../actions/trigger.ts";
import { registerAttachmentKnowledgeBackfillTask } from "../api/attachment-knowledge-backfill.ts";
import { registerAttachmentKnowledgeIngestHook } from "../api/attachment-knowledge-ingest.ts";
import {
  backgroundGenerateImageRoute,
  backgroundUploadImageRoute,
} from "../api/background-routes.ts";
import { filesRoutes } from "../api/files-routes.ts";
import {
  mediaFileRoute,
  registerMediaGcTask,
  registerMediaPipelineHook,
} from "../api/media-runtime.ts";
import { adminPanelProvider } from "../providers/admin-panel.ts";
import { adminTrustProvider } from "../providers/admin-trust.ts";
import { automationTerminalBridgeProvider } from "../providers/automation-terminal-bridge.ts";
import { escalationTriggerProvider } from "../providers/escalation-trigger.ts";
import { pageScopedContextProvider } from "../providers/page-scoped-context.ts";
import { pendingPermissionsProvider } from "../providers/pending-permissions-provider.ts";
import { recentConversationsProvider } from "../providers/recent-conversations.ts";
import { relevantConversationsProvider } from "../providers/relevant-conversations.ts";
import { roleBackfillProvider } from "../providers/role-backfill.ts";
import { rolodexProvider } from "../providers/rolodex.ts";
import { createSessionKeyProvider } from "../providers/session-bridge.ts";
import {
  getSessionProviders,
  resolveDefaultSessionStorePath,
} from "../providers/session-utils.ts";
import { createDynamicSkillProvider } from "../providers/skill-provider.ts";
import { createOngoingTasksProvider } from "../providers/tasks.ts";
import {
  uiGenerativeProvider,
  uiWidgetsProvider,
} from "../providers/ui-catalog.ts";
import { createUserNameProvider } from "../providers/user-name.ts";
import { createWorkspaceProvider } from "../providers/workspace-provider.ts";
import { ApprovalService } from "../services/approval/index.ts";
import { ElizaCharacterPersistenceService } from "../services/character-persistence.ts";
import { LocalFileStorageService } from "../services/file-storage.ts";
import { GlobalPauseService } from "../services/global-pause/index.ts";
import { HandoffService } from "../services/handoff/index.ts";
import {
  KnowledgeGraphService,
  knowledgeGraphSchema,
} from "../services/knowledge-graph/index.ts";
import { AgentMediaGenerationService } from "../services/media-generation.ts";
import { PendingPromptsService } from "../services/pending-prompts/index.ts";
import { PermissionRegistry } from "../services/permissions-registry.ts";
import { NotificationPushService } from "../services/push/notification-push-service.ts";
import { resolveDefaultAgentWorkspaceDir } from "../shared/workspace-resolution.ts";
import { registerTriggerTaskWorker } from "../triggers/runtime.ts";
import { migrateWorkbenchScheduleTags } from "../triggers/workbench-migration.ts";

import { setCustomActionsRuntime } from "./custom-actions.ts";
import { registerErrorEscalation } from "./error-escalation.ts";

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
    createWorkspaceProvider({
      workspaceDir,
      maxCharsPerFile: config?.initMaxChars,
    }),
    adminTrustProvider,
    adminPanelProvider,

    createSessionKeyProvider({ defaultAgentId: agentId }),
    ...getSessionProviders({ storePath: sessionStorePath }),
    createDynamicSkillProvider(),
    pendingPermissionsProvider,
    createUserNameProvider(),
    createOngoingTasksProvider(),
  ];

  const plugin: Plugin = {
    name: "eliza",
    description: "Eliza workspace context, session keys, and lifecycle actions",

    // Runtime-owned knowledge graph (entity nodes + typed relationship edges)
    // under the app_lifeops schema. Registered here so the tables exist
    // whenever the runtime runs and are migrated by the SQL plugin.
    schema: knowledgeGraphSchema,

    services: [
      AgentEventService as ServiceClass,
      NotificationService as ServiceClass,
      NotificationPushService as ServiceClass,
      ElizaCharacterPersistenceService as ServiceClass,
      AgentMediaGenerationService as ServiceClass,
      LocalFileStorageService as ServiceClass,
      PermissionRegistry as ServiceClass,
      KnowledgeGraphService as ServiceClass,
      PendingPromptsService as ServiceClass,
      GlobalPauseService as ServiceClass,
      HandoffService as ServiceClass,
      ApprovalService as ServiceClass,
    ],

    init: async (_pluginConfig, runtime: IAgentRuntime) => {
      registerTriggerTaskWorker(runtime);
      // One-time (#12177): fold legacy `schedule:<cron>` tag encoding on
      // workbench tasks into a prompt-kind TriggerConfig. Idempotent; a
      // failure must not block boot.
      void migrateWorkbenchScheduleTags(runtime).catch((err) => {
        runtime.logger.warn(
          { src: "trigger-runtime", err: String(err) },
          "Workbench schedule-tag migration failed",
        );
      });
      registerErrorEscalation(runtime);
      setCustomActionsRuntime(runtime);
      // Media store: persist inline data: URLs out of context/history, and
      // sweep orphaned files daily. The serving route is declared below.
      registerMediaPipelineHook(runtime);
      registerMediaGcTask(runtime);
      // Attachment → knowledge ingest (#13593): mirror chat attachments into the
      // knowledge store, tagged by room/sender/role/media-format, with a
      // source-trust-derived scope (owner/DM → owner-private; public room →
      // user-private) so owner-only knowledge cannot spill into public rooms.
      registerAttachmentKnowledgeIngestHook(runtime);
      // One-time (#13593): backfill room/media-format tags onto pre-existing
      // transcript-mirror knowledge records. Idempotent; must not block boot.
      registerAttachmentKnowledgeBackfillTask(runtime);
      const registerSkillsAsCommands = () => {
        const skillsService = runtime.getService("AGENT_SKILLS_SERVICE");
        if (!isAgentSkillsService(skillsService)) return false;

        const skills = skillsService.getLoadedSkills();
        if (skills.length === 0) return false;

        // Commands are contributed through the runtime service registered by
        // the commands plugin — no import edge into it, and the service
        // appends without resetting commands other plugins registered.
        const commands = runtime.getService<CommandRegistryService>("commands");
        if (!commands) return false;

        let registered = 0;
        for (const skill of skills) {
          const slug = skill.slug.toLowerCase();
          commands.register({
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
          registered++;
        }

        if (registered > 0) {
          logger.info(
            `[eliza] Registered ${registered} skills as slash commands`,
          );
        }
        return true;
      };

      if (!registerSkillsAsCommands()) {
        setTimeout(() => registerSkillsAsCommands(), 5000);
      }
    },

    providers: [
      ...baseProviders,

      automationTerminalBridgeProvider,
      pageScopedContextProvider,
      recentConversationsProvider,
      relevantConversationsProvider,
      rolodexProvider,

      uiWidgetsProvider,
      uiGenerativeProvider,
      roleBackfillProvider,
      escalationTriggerProvider,
    ],

    // Public media route — only reached on iOS (in-process dispatch, no HTTP
    // server). HTTP platforms serve media via the pre-auth handler in server.ts.
    routes: [
      mediaFileRoute,
      backgroundGenerateImageRoute,
      backgroundUploadImageRoute,
      ...filesRoutes,
    ],

    actions: [
      terminalAction,
      ...promoteSubactionsToActions(triggerAction),
      pageDelegateAction,
      ...promoteSubactionsToActions(contactAction),
      settingsAction,
      ...promoteSubactionsToActions(pluginAction),
      // Observability / introspection actions
      ...promoteSubactionsToActions(logsAction),
      ...promoteSubactionsToActions(runtimeAction),
      ...promoteSubactionsToActions(databaseAction),
      compactConversationAction,
      connectAccountAction,
      notifyAction,
      ...promoteSubactionsToActions(memoryAction),
      filesAction,
      // Global knowledge-hub actions (#13595): search + attach-to-chat +
      // send-to-someone, callable from any view.
      ...knowledgeActions,
      // SCHEDULE_FOLLOW_UP is now the `followup` op on contactAction.
      // ARCHIVE_CODING_TASK / REOPEN_CODING_TASK live as ops on the TASKS
      // parent in @elizaos/plugin-agent-orchestrator (also surfaced via the
      // CODE umbrella).
    ],

    async dispose(runtime) {
      await runtime
        .getService<PermissionRegistry>(PermissionRegistry.serviceType)
        ?.stop();
      await runtime
        .getService<AgentMediaGenerationService>(
          AgentMediaGenerationService.serviceType,
        )
        ?.stop();
      await runtime
        .getService<ElizaCharacterPersistenceService>(
          ElizaCharacterPersistenceService.serviceType,
        )
        ?.stop();
      await runtime
        .getService<AgentEventService>(AgentEventService.serviceType)
        ?.stop();
    },
  };

  return plugin;
}
