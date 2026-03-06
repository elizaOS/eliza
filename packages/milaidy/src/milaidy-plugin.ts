/**
 * Milaidy plugin for elizaOS — workspace context and session keys.
 *
 * Compaction is now a built-in runtime action (COMPACT_SESSION in basic-capabilities).
 * Memory search/get actions are superseded by plugin-scratchpad.
 */

import type { Plugin, MessagePayload } from "@elizaos/core";
import { getSessionProviders, resolveDefaultSessionStorePath } from "@elizaos/core";
import { createWorkspaceProvider } from "./providers/workspace-provider.js";
import { createSessionKeyProvider, resolveSessionKeyFromRoom } from "./providers/session-bridge.js";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "./providers/workspace.js";

export type MilaidyPluginConfig = {
  workspaceDir?: string;
  bootstrapMaxChars?: number;
  sessionStorePath?: string;
  agentId?: string;
};

export function createMilaidyPlugin(config?: MilaidyPluginConfig): Plugin {
  const workspaceDir = config?.workspaceDir ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const agentId = config?.agentId ?? "main";
  const sessionStorePath = config?.sessionStorePath ?? resolveDefaultSessionStorePath(agentId);

  return {
    name: "milaidy",
    description: "Milaidy workspace context and session keys",

    providers: [
      createWorkspaceProvider({ workspaceDir, maxCharsPerFile: config?.bootstrapMaxChars }),
      createSessionKeyProvider({ defaultAgentId: agentId }),
      ...getSessionProviders({ storePath: sessionStorePath }),
    ],

    events: {
      // Inject Milaidy session keys into inbound messages before processing
      MESSAGE_RECEIVED: [
        async (payload: MessagePayload) => {
          const { runtime, message } = payload;
          if (!message || !runtime) return;

          const meta = (message.metadata ?? {}) as Record<string, unknown>;
          if (meta.sessionKey) return;

          const room = await runtime.getRoom(message.roomId);
          if (!room) return;

          const key = resolveSessionKeyFromRoom(agentId, room, {
            threadId: meta.threadId as string | undefined,
            groupId: meta.groupId as string | undefined,
            channel: (meta.channel as string | undefined) ?? room.source,
          });
          (message.metadata as Record<string, unknown>).sessionKey = key;
        },
      ],
    },
  };
}

