/**
 * Eliza plugin for elizaOS — workspace context, session keys, and agent
 * lifecycle actions (restart).
 *
 * Compaction is handled by core auto-compaction in the recent-messages provider.
 * Memory search/get actions are superseded by plugin-scratchpad.
 */

import type {
  IAgentRuntime,
  Plugin,
  Provider,
  ProviderResult,
  ServiceClass,
} from "@elizaos/core";
import { AgentEventService } from "@elizaos/core";
import { emoteAction } from "../actions/emote";
import { restartAction } from "../actions/restart";
import { sendMessageAction } from "../actions/send-message";
import {
  goLiveAction,
  goOfflineAction,
  manageOverlayWidgetAction,
  setStreamDestinationAction,
  speakOnStreamAction,
} from "../actions/stream-control";
import { switchStreamSourceAction } from "../actions/switch-stream-source";
import { terminalAction } from "../actions/terminal";
import { adminTrustProvider } from "../providers/admin-trust";

import { createSessionKeyProvider } from "../providers/session-bridge";
import {
  getSessionProviders,
  resolveDefaultSessionStorePath,
} from "../providers/session-utils";
import { createChannelProfileProvider } from "../providers/simple-mode";
import { uiCatalogProvider } from "../providers/ui-catalog";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../providers/workspace";
import { createWorkspaceProvider } from "../providers/workspace-provider";
import { createTriggerTaskAction } from "../triggers/action";
import { registerTriggerTaskWorker } from "../triggers/runtime";
import { loadCustomActions, setCustomActionsRuntime } from "./custom-actions";

export type ElizaPluginConfig = {
  workspaceDir?: string;
  initMaxChars?: number;
  sessionStorePath?: string;
  agentId?: string;
};

export function createElizaPlugin(config?: ElizaPluginConfig): Plugin {
  const workspaceDir = config?.workspaceDir ?? DEFAULT_AGENT_WORKSPACE_DIR;
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

    createSessionKeyProvider({ defaultAgentId: agentId }),
    ...getSessionProviders({ storePath: sessionStorePath }),
  ];

  // Emote IDs are now declared as an enum on the PLAY_EMOTE action parameter,
  // so they appear in the `# Available Actions` section automatically via
  // core's formatActions. No separate provider injection needed.
  //
  // Backwards-compat: character.settings.DISABLE_EMOTES still works — when set,
  // the PLAY_EMOTE action is excluded at init time so it never appears in the
  // prompt. Previously this was checked per-request in the emote provider.

  // Custom actions provider — tells the LLM about available custom actions.
  const customActionsProvider: Provider = {
    name: "customActions",
    description: "User-defined custom actions",

    async get(): Promise<ProviderResult> {
      const customActions = loadCustomActions();
      if (customActions.length === 0) {
        // Don't waste tokens telling the LLM there are no custom actions.
        return { text: "" };
      }

      const lines = customActions.map((a) => {
        const params =
          a.parameters
            ?.map((p) => `${p.name}${p.required ? " (required)" : ""}`)
            .join(", ") || "none";
        return `- **${a.name}**: ${a.description} [params: ${params}]`;
      });

      return {
        text: [
          "## Custom Actions",
          "",
          "The following custom actions are available:",
          ...lines,
        ].join("\n"),
      };
    },
  };

  const plugin: Plugin = {
    name: "eliza",
    description: "Eliza workspace context, session keys, and lifecycle actions",

    services: [AgentEventService as ServiceClass],

    init: async (_pluginConfig, runtime: IAgentRuntime) => {
      registerTriggerTaskWorker(runtime);
      setCustomActionsRuntime(runtime);

      // Honour DISABLE_EMOTES: remove PLAY_EMOTE so it never appears in prompts.
      if (runtime.character?.settings?.DISABLE_EMOTES) {
        const idx = plugin.actions?.findIndex((a) => a.name === "PLAY_EMOTE");
        if (idx != null && idx >= 0) {
          plugin.actions?.splice(idx, 1);
        }
      }
    },

    providers: [
      ...baseProviders,

      uiCatalogProvider,
      customActionsProvider,
    ],

    actions: [
      restartAction,
      sendMessageAction,
      terminalAction,
      createTriggerTaskAction,
      emoteAction,
      switchStreamSourceAction,
      goLiveAction,
      goOfflineAction,
      setStreamDestinationAction,
      speakOnStreamAction,
      manageOverlayWidgetAction,
      ...loadCustomActions(),
    ],
  };

  return plugin;
}
