import { type Content, createUniqueUuid, type Memory } from "@elizaos/core";
import {
  emitRetakeEvent,
  fetchChatComments,
  getMessageService,
  getMessagingAPI,
  sendChatMessage,
} from "./chat-api.ts";
import {
  CHAT_POLL_INTERVAL_MS,
  MAX_CHAT_MESSAGE_LENGTH,
  TAG,
  VIEWER_STATS_POLL_INTERVAL_MS,
} from "./constants.ts";
import { resolveEmoteFromChat, triggerEmote } from "./emotes.ts";
import {
  cachedAccessToken,
  cachedApiUrl,
  chatPollInFlight,
  chatPollTimer,
  initialPollDone,
  lastSeenId,
  ourUserDbId,
  pluginRuntime,
  seenViewers,
  setChatPollInFlight,
  setChatPollTimer,
  setInitialPollDone,
  setLastSeenId,
  setViewerStatsPollTimer,
  trackViewer,
  viewerStatsPollTimer,
} from "./state.ts";

// ---------------------------------------------------------------------------
// Chat polling
// ---------------------------------------------------------------------------

export async function pollChat(): Promise<void> {
  if (chatPollInFlight) return; // skip if previous poll still running
  setChatPollInFlight(true);
  try {
    await pollChatInner();
  } finally {
    setChatPollInFlight(false);
  }
}

async function pollChatInner(): Promise<void> {
  if (!pluginRuntime) return;
  const runtime = pluginRuntime;
  const accessToken = cachedAccessToken;
  const apiUrl = cachedApiUrl;
  if (!accessToken || !ourUserDbId) return;

  const currentUserDbId = ourUserDbId;

  try {
    const comments = await fetchChatComments(
      apiUrl,
      accessToken,
      currentUserDbId,
      50,
    );

    // On first poll, set cursor to newest message and skip processing.
    if (!lastSeenId) {
      if (comments.length > 0) {
        let maxId = comments[0]?.chat_event_id;
        for (const c of comments) {
          if (Number(c.chat_event_id) > Number(maxId)) maxId = c.chat_event_id;
        }
        setLastSeenId(maxId);
        pluginRuntime?.logger.info(
          `${TAG} Initial fetch: ${comments.length} comments — cursor set to ${lastSeenId}`,
        );
      }
      return;
    }

    // Comments come newest-first; process oldest-first
    const sorted = [...comments].reverse();

    for (const comment of sorted) {
      if (lastSeenId && Number(comment.chat_event_id) <= Number(lastSeenId))
        continue;

      // Skip own messages
      if (comment.sender_user_id === currentUserDbId) continue;

      // Update cursor
      setLastSeenId(comment.chat_event_id);

      // Sanitize: cap message length to prevent prompt injection via long payloads
      if (comment.text.length > MAX_CHAT_MESSAGE_LENGTH) {
        comment.text = comment.text.slice(0, MAX_CHAT_MESSAGE_LENGTH);
      }

      // Sanitize usernames: truncate and strip control characters
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional sanitization of control chars
      // eslint-disable-next-line no-control-regex
      const ctrlRe = /[\x00-\x1f\x7f]/g;
      const sanitizeName = (s: string) => s.replace(ctrlRe, "").slice(0, 100);
      comment.sender_username = sanitizeName(comment.sender_username);
      if (comment.sender_display_name) {
        comment.sender_display_name = sanitizeName(comment.sender_display_name);
      }

      // Build IDs
      const entityId = createUniqueUuid(runtime, comment.sender_user_id);
      const roomId = createUniqueUuid(runtime, currentUserDbId);
      const messageId = createUniqueUuid(runtime, comment.chat_event_id);
      const worldId = createUniqueUuid(runtime, "retake-world");

      // Ensure entity + room
      await runtime.ensureConnection({
        entityId,
        roomId,
        userName: comment.sender_username,
        name: comment.sender_display_name || comment.sender_username,
        source: "retake",
        channelId: comment.sender_user_id,
        type: "GROUP",
        worldId,
        worldName: "Retake Stream",
      });

      const memory: Memory = {
        id: messageId,
        entityId,
        agentId: runtime.agentId,
        roomId,
        content: {
          text: comment.text,
          source: "retake",
          channelType: "GROUP",
        },
        metadata: {
          type: "custom" as const,
          entityName: comment.sender_username,
          fromId: comment.sender_user_id,
          wallet: comment.sender_wallet_address,
        } as Record<string, unknown>,
        createdAt: Number(comment.timestamp) || Date.now(),
      };

      runtime.logger.info(
        `${TAG} Chat from @${comment.sender_username}: "${comment.text.slice(0, 80)}"`,
      );

      // Emit inbound message to AGENT_EVENT for UI visibility
      emitRetakeEvent(
        runtime,
        "message",
        {
          text: comment.text,
          from: comment.sender_username,
          displayName: comment.sender_display_name || comment.sender_username,
          pfp: comment.sender_pfp,
          direction: "inbound",
          channel: "retake",
        },
        String(roomId),
      );

      // Detect new viewers (trackViewer returns true for first-time additions)
      if (trackViewer(comment.sender_username)) {
        if (initialPollDone) {
          emitRetakeEvent(
            runtime,
            "new_viewer",
            {
              text: `New viewer: @${comment.sender_username}`,
              from: comment.sender_username,
              displayName:
                comment.sender_display_name || comment.sender_username,
              pfp: comment.sender_pfp,
              channel: "retake",
            },
            String(roomId),
          );
        }
      }

      // Response callback — sends agent reply to retake chat
      const chatUserDbId = currentUserDbId;
      const callback = async (responseContent: Content): Promise<Memory[]> => {
        try {
          if (
            responseContent.target &&
            typeof responseContent.target === "string" &&
            responseContent.target.toLowerCase() !== "retake"
          ) {
            return [];
          }
          const replyText = responseContent.text ?? "";
          runtime.logger.info(
            `${TAG} Callback fired for @${comment.sender_username} (target=${responseContent.target ?? "none"}, text=${replyText.slice(0, 40) || "(empty)"})`,
          );
          if (!replyText.trim()) return [];

          await sendChatMessage(apiUrl, accessToken, replyText, chatUserDbId);
          runtime.logger.info(
            `${TAG} Replied to @${comment.sender_username}: "${replyText.slice(0, 80)}"`,
          );

          // Emit outbound reply to AGENT_EVENT for UI visibility
          emitRetakeEvent(
            runtime,
            "assistant",
            {
              text: replyText,
              to: comment.sender_username,
              direction: "outbound",
              channel: "retake",
            },
            String(roomId),
          );

          // Emit agent thought if present
          if (
            responseContent.thought &&
            typeof responseContent.thought === "string"
          ) {
            emitRetakeEvent(
              runtime,
              "thought",
              {
                text: responseContent.thought,
                channel: "retake",
              },
              String(roomId),
            );
          }

          // Emit actions if present
          const actions = responseContent.actions;
          if (Array.isArray(actions) && actions.length > 0) {
            emitRetakeEvent(
              runtime,
              "action",
              {
                text: `Executing: ${actions.join(", ")}`,
                actions,
                channel: "retake",
              },
              String(roomId),
            );
          }

          // Auto-trigger emote based on the original viewer message OR the
          // agent's chosen actions.
          const shouldEmote =
            (Array.isArray(actions) && actions.includes("PLAY_EMOTE")) ||
            resolveEmoteFromChat(comment.text);
          if (shouldEmote) {
            const emoteId =
              typeof shouldEmote === "string"
                ? shouldEmote
                : resolveEmoteFromChat(comment.text) || "wave";
            void triggerEmote(emoteId as string);
          }

          const replyMemory: Memory = {
            id: createUniqueUuid(runtime, `retake-reply-${Date.now()}`),
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            roomId,
            content: {
              ...responseContent,
              text: replyText,
              source: "retake",
              channelType: "GROUP",
              inReplyTo: messageId,
            },
            createdAt: Date.now(),
          };

          await runtime.createMemory(replyMemory, "messages");
          return [replyMemory];
        } catch (err) {
          runtime.logger.error(
            `${TAG} Error sending chat reply: ${err instanceof Error ? err.message : String(err)}`,
          );
          return [];
        }
      };

      // Route through message pipeline (same pattern as WhatsApp)
      const messagingAPI = getMessagingAPI(runtime);
      const messageService = getMessageService(runtime);

      if (messagingAPI) {
        await messagingAPI.sendMessage(runtime.agentId, memory, {
          onResponse: callback,
        });
      } else if (messageService) {
        await messageService.handleMessage(runtime, memory, callback);
      } else {
        await (
          runtime.emitEvent as (
            event: string[],
            params: Record<string, unknown>,
          ) => Promise<void>
        )(["MESSAGE_RECEIVED"], {
          runtime,
          message: memory,
          callback,
          source: "retake",
        });
      }
    }
  } catch (err) {
    pluginRuntime?.logger.error(
      `${TAG} Chat poll error: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    // Mark first poll done so subsequent new viewers trigger events
    if (!initialPollDone) setInitialPollDone(true);
  }
}

export function startChatPolling(): void {
  if (chatPollTimer) return;
  setChatPollTimer(
    setInterval(() => {
      pollChat().catch((err) => {
        pluginRuntime?.logger.error(`${TAG} Unhandled poll error: ${err}`);
      });
    }, CHAT_POLL_INTERVAL_MS),
  );
  pluginRuntime?.logger.info(
    `${TAG} Chat polling started (${CHAT_POLL_INTERVAL_MS}ms interval)`,
  );
}

export function stopChatPolling(): void {
  if (chatPollTimer) {
    clearInterval(chatPollTimer);
    setChatPollTimer(null);
    pluginRuntime?.logger.info(`${TAG} Chat polling stopped`);
  }
}

// ---------------------------------------------------------------------------
// Viewer stats polling — emits viewer_stats events
// ---------------------------------------------------------------------------

async function pollViewerStats(): Promise<void> {
  if (!pluginRuntime) return;
  const runtime = pluginRuntime;

  try {
    let apiViewerCount: number | null = null;

    // Best-effort: try retake public API for active sessions
    try {
      const res = await fetch(
        `${cachedApiUrl.replace("/api/v1", "")}/api/v1/sessions/active/`,
        {
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (res.ok) {
        const sessions = (await res.json()) as Array<Record<string, unknown>>;
        const ourSession = sessions.find(
          (s) => s.streamer_id === ourUserDbId || s.user_id === ourUserDbId,
        );
        if (ourSession && typeof ourSession.viewer_count === "number") {
          apiViewerCount = ourSession.viewer_count;
        }
      }
    } catch {
      // Non-fatal — public API may not expose this
    }

    emitRetakeEvent(runtime, "viewer_stats", {
      uniqueChatters: seenViewers.size,
      apiViewerCount,
      channel: "retake",
    });
  } catch {
    // Non-fatal
  }
}

export function startViewerStatsPolling(): void {
  if (viewerStatsPollTimer) return;
  setViewerStatsPollTimer(
    setInterval(() => {
      pollViewerStats().catch(() => {});
    }, VIEWER_STATS_POLL_INTERVAL_MS),
  );
  pluginRuntime?.logger.info(
    `${TAG} Viewer stats polling started (${VIEWER_STATS_POLL_INTERVAL_MS}ms interval)`,
  );
}

export function stopViewerStatsPolling(): void {
  if (viewerStatsPollTimer) {
    clearInterval(viewerStatsPollTimer);
    setViewerStatsPollTimer(null);
    pluginRuntime?.logger.info(`${TAG} Viewer stats polling stopped`);
  }
}
