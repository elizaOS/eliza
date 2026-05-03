/**
 * @elizaos/plugin-retake — Retake.tv streaming + chat integration plugin.
 *
 * Manages RTMP streaming to retake.tv via FFmpeg, including browser capture,
 * frame piping, and stream lifecycle (go-live / go-offline).
 *
 * Additionally provides:
 * - Chat polling: reads retake.tv stream chat, routes messages to the agent
 * - Agent actions: START_RETAKE_STREAM, STOP_RETAKE_STREAM, GET_RETAKE_STREAM_STATUS
 * - Emote system: PLAY_EMOTE action + auto-trigger from viewer chat
 * - Streaming destination: createRetakeDestination() for RTMP pipeline
 */

import type {
  IAgentRuntime,
  Memory,
  Plugin,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import {
  getRetakeStreamStatusAction,
  startRetakeStreamAction,
  stopRetakeStreamAction,
} from "./actions.ts";
import {
  RETAKE_MESSAGE_EXAMPLES,
  RETAKE_SYSTEM_PROMPT,
  RETAKE_TOPICS,
} from "./character.ts";
import {
  startChatPolling,
  startViewerStatsPolling,
  stopChatPolling,
  stopViewerStatsPolling,
} from "./chat-poll.ts";
import { TAG } from "./constants.ts";
import {
  ourUserDbId,
  seenViewers,
  setCachedAccessToken,
  setCachedApiUrl,
  setOurUserDbId,
  setPluginRuntime,
} from "./state.ts";

/** Handle for the deferred userDbId re-discovery timer so cleanup can cancel it. */
let deferredDiscoveryTimer: ReturnType<typeof setTimeout> | null = null;

export {
  RETAKE_MESSAGE_EXAMPLES,
  RETAKE_SYSTEM_PROMPT,
  RETAKE_TOPICS,
} from "./character.ts";
export { stopChatPolling, stopViewerStatsPolling } from "./chat-poll.ts";
// Re-export public API
export { createRetakeDestination } from "./destination.ts";
export type { RetakeChatComment, StreamingDestination } from "./types.ts";

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const retakePlugin: Plugin = {
  name: "retake",
  description:
    "Retake.tv RTMP streaming with chat integration and agent actions",

  config: {
    RETAKE_AGENT_TOKEN: process.env.RETAKE_AGENT_TOKEN ?? "",
    RETAKE_API_URL: process.env.RETAKE_API_URL ?? "https://retake.tv/api/v1",
    RETAKE_USER_DB_ID: process.env.RETAKE_USER_DB_ID ?? "",
  },

  actions: [
    startRetakeStreamAction,
    stopRetakeStreamAction,
    getRetakeStreamStatusAction,
    // Note: PLAY_EMOTE is registered by eliza-plugin (src/actions/emote.ts)
    // — do NOT duplicate here as conflicting registrations cause the action to fail.
  ],

  providers: [
    {
      name: "retake-context",
      description: "Retake.tv streaming context and action instructions",
      async get(
        _runtime: IAgentRuntime,
        _message: Memory,
        _state: State,
      ): Promise<ProviderResult> {
        return { text: RETAKE_SYSTEM_PROMPT };
      },
    } satisfies Provider,
  ],

  init: async (config: Record<string, string>, runtime: IAgentRuntime) => {
    setPluginRuntime(runtime);

    // -----------------------------------------------------------------------
    // Inject retake topics + system prompt + message examples into character
    // -----------------------------------------------------------------------
    const character = runtime.character as Record<string, unknown>;

    // Append retake topics
    const existingTopics = Array.isArray(character.topics)
      ? (character.topics as string[])
      : [];
    const topicSet = new Set([...existingTopics, ...RETAKE_TOPICS]);
    character.topics = Array.from(topicSet);

    // Inject retake system prompt
    const existingSystem =
      typeof character.system === "string" ? character.system : "";
    if (!existingSystem.includes("Retake.tv Live Streaming")) {
      character.system = existingSystem
        ? `${existingSystem}\n\n${RETAKE_SYSTEM_PROMPT}`
        : RETAKE_SYSTEM_PROMPT;
      runtime.logger.info(`${TAG} Injected retake system prompt`);
    }

    // Inject retake message examples
    const convertedRetakeExamples = RETAKE_MESSAGE_EXAMPLES.map((convo) => ({
      examples: convo.map((msg) => ({
        name: msg.user,
        content: msg.content,
      })),
    }));
    const existingExamples = Array.isArray(character.messageExamples)
      ? (character.messageExamples as typeof convertedRetakeExamples)
      : [];
    character.messageExamples = [
      ...existingExamples,
      ...convertedRetakeExamples,
    ];

    runtime.logger.info(
      `${TAG} Added ${RETAKE_TOPICS.length} topics, ${RETAKE_MESSAGE_EXAMPLES.length} examples`,
    );

    // -----------------------------------------------------------------------
    // Chat polling setup
    // -----------------------------------------------------------------------

    setCachedAccessToken(
      (
        config?.RETAKE_AGENT_TOKEN ||
        process.env.RETAKE_AGENT_TOKEN ||
        ""
      ).trim(),
    );
    setCachedApiUrl(
      (
        config?.RETAKE_API_URL ||
        process.env.RETAKE_API_URL ||
        "https://retake.tv/api/v1"
      ).trim(),
    );

    setOurUserDbId(
      config?.RETAKE_USER_DB_ID?.trim() ||
        process.env.RETAKE_USER_DB_ID?.trim() ||
        null,
    );

    // Import state for reading after setting
    const { cachedAccessToken: accessToken, cachedApiUrl: apiUrl } =
      await import("./state.ts");

    runtime.logger.info(
      `${TAG} Token: ${accessToken ? "configured" : "not configured"}`,
    );

    if (!accessToken) {
      runtime.logger.info(
        `${TAG} No access token configured — chat polling disabled`,
      );
      return;
    }

    // Auto-discover userDbId from stream status
    const discoverUserDbId = async (label: string): Promise<boolean> => {
      try {
        const statusRes = await fetch(`${apiUrl}/agent/stream/status`, {
          headers: { Authorization: `Bearer ${accessToken}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (statusRes.ok) {
          const statusData = (await statusRes.json()) as Record<
            string,
            unknown
          >;
          if (statusData.userDbId) {
            const newId = String(statusData.userDbId);
            if (newId !== ourUserDbId) {
              setOurUserDbId(newId);
              runtime.logger.info(
                `${TAG} ${label}: userDbId=${newId} (live=${statusData.is_live})`,
              );
            }
            return true;
          }
        }
      } catch {
        // Non-fatal
      }
      return false;
    };

    if (!ourUserDbId) {
      await discoverUserDbId("Initial discovery");
    }

    startChatPolling();
    startViewerStatsPolling();

    if (ourUserDbId) {
      runtime.logger.info(
        `${TAG} Plugin initialized with chat polling (userDbId: ${ourUserDbId})`,
      );
    } else {
      runtime.logger.warn(
        `${TAG} userDbId not yet known — will re-discover after stream starts`,
      );
    }

    // Re-discover userDbId after a delay (stream auto-start takes ~5-10s)
    deferredDiscoveryTimer = setTimeout(async () => {
      deferredDiscoveryTimer = null;
      const found = await discoverUserDbId("Deferred re-discovery");
      if (!found && !ourUserDbId) {
        runtime.logger.warn(
          `${TAG} Still no userDbId after deferred discovery — chat polling will not process messages. Set RETAKE_USER_DB_ID env var.`,
        );
      }
    }, 15_000);
  },

  dispose: async () => {
    stopChatPolling();
    stopViewerStatsPolling();
    if (deferredDiscoveryTimer) {
      clearTimeout(deferredDiscoveryTimer);
      deferredDiscoveryTimer = null;
    }
    setPluginRuntime(null);
    seenViewers.clear();
  },
};

export default retakePlugin;
