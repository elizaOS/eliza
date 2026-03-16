/**
 * Milady plugin for elizaOS — workspace context, session keys, and agent
 * lifecycle actions (restart).
 *
 * Compaction is handled by core auto-compaction in the recent-messages provider.
 * Memory search/get actions are superseded by plugin-scratchpad.
 */

import type {
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  ServiceClass,
  State,
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
import { AGENT_EMOTE_CATALOG } from "../emotes/catalog";
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

export type MiladyPluginConfig = {
  workspaceDir?: string;
  bootstrapMaxChars?: number;
  sessionStorePath?: string;
  agentId?: string;
};

export function createMiladyPlugin(config?: MiladyPluginConfig): Plugin {
  const workspaceDir = config?.workspaceDir ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const agentId = config?.agentId ?? "main";
  const sessionStorePath =
    config?.sessionStorePath ?? resolveDefaultSessionStorePath(agentId);

  const baseProviders = [
    createChannelProfileProvider(),
    createWorkspaceProvider({
      workspaceDir,
      maxCharsPerFile: config?.bootstrapMaxChars,
    }),
    adminTrustProvider,

    createSessionKeyProvider({ defaultAgentId: agentId }),
    ...getSessionProviders({ storePath: sessionStorePath }),
  ];

  // Emote provider — injects available emotes into agent context so the LLM
  // knows it can trigger animations via the PLAY_EMOTE action.
  // Gated on character.settings — disable for agents without 3D avatars.
  const emoteProvider: Provider = {
    name: "emotes",
    description: "Available avatar emote animations",

    async get(
      _runtime: IAgentRuntime,
      _message: Memory,
      _state: State,
    ): Promise<ProviderResult> {
      // Skip emote injection for agents without avatars.
      // Set character.settings.DISABLE_EMOTES = true to save ~300 tokens.
      const settings = _runtime.character?.settings;
      if (settings?.DISABLE_EMOTES) {
        return { text: "" };
      }
      const ids = AGENT_EMOTE_CATALOG.map((e) => e.id).join(", ");
      return {
        text: [
          "## Available Emotes",
          "",
          "You have a 3D VRM avatar that can perform emote animations via the PLAY_EMOTE action.",
          "Use PLAY_EMOTE whenever a visible gesture, reaction, or trick helps.",
          "PLAY_EMOTE is a silent one-shot visual side action. It does not speak or post chat text by itself, and it returns to idle automatically.",
          'If you also want text, chain PLAY_EMOTE with REPLY in the same turn — for example actions: ["PLAY_EMOTE", "REPLY"] or ["REPLY", "PLAY_EMOTE"].',
          "Only call PLAY_EMOTE when you set the required emote parameter to a valid emote ID. If you cannot choose one, do not call it.",
          "Set the emote parameter to the emote ID you want.",
          "",
          `Available emote IDs: ${ids}`,
          "",
          "Do not use idle, run, or walk with PLAY_EMOTE.",
          "Common mappings: dance/vibe → dance-happy, wave/greet → wave, flip/backflip → flip, cry/sad → crying, fight/punch → punching, fish → fishing",
        ].join("\n"),
      };
    },
  };

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
            ?.map(
              (p) =>
                `${p.name}${(p as { required?: boolean }).required ? " (required)" : ""}`,
            )
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

  return {
    name: "milady",
    description:
      "Milady workspace context, session keys, and lifecycle actions",

    services: [AgentEventService as unknown as ServiceClass],

    init: async (_pluginConfig, runtime) => {
      registerTriggerTaskWorker(runtime);
      setCustomActionsRuntime(runtime);
    },

    providers: [
      ...baseProviders,

      uiCatalogProvider,
      emoteProvider,
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
}
