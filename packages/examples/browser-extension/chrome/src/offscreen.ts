/**
 * Offscreen document script
 *
 * Runs the ElizaOS runtime in a long-lived extension page so that
 * inference/streaming continues even if the popup is closed.
 */

import type { ExtensionConfig, PageContent } from "../../shared/types";
import {
  resetConversation,
  sendMessage,
  updatePageContent,
  updateSelectedText,
} from "../../shared/eliza-runtime-full";

type OffscreenSendChatRequest = {
  type: "OFFSCREEN_SEND_CHAT";
  messageId: string;
  url: string;
  userText: string;
  config: ExtensionConfig;
  pageContent: PageContent | null;
};

type OffscreenPingRequest = { type: "OFFSCREEN_PING" };
type OffscreenResetRequest = { type: "OFFSCREEN_RESET" };

type OffscreenRequest = OffscreenSendChatRequest | OffscreenPingRequest | OffscreenResetRequest;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOffscreenSendChatRequest(value: unknown): value is OffscreenSendChatRequest {
  if (!isObject(value)) return false;
  return (
    value.type === "OFFSCREEN_SEND_CHAT" &&
    typeof value.messageId === "string" &&
    typeof value.url === "string" &&
    typeof value.userText === "string" &&
    isObject(value.config)
  );
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  (async () => {
    try {
      if (isObject(message) && message.type === "OFFSCREEN_PING") {
        sendResponse({ ok: true });
        return;
      }
      if (isObject(message) && message.type === "OFFSCREEN_RESET") {
        await resetConversation();
        sendResponse({ ok: true });
        return;
      }

      if (!isOffscreenSendChatRequest(message)) {
        sendResponse({ ok: false, error: "Unknown offscreen message" });
        return;
      }

      const { messageId, url, userText, config, pageContent } = message;

      // Update cached context for the runtime
      updatePageContent(pageContent);
      updateSelectedText(pageContent?.selectedText ?? null);

      // Stream back chunks to background
      let accumulated = "";
      await sendMessage(config, userText, {
        onAssistantChunk: (chunk) => {
          accumulated += chunk;
          chrome.runtime.sendMessage({
            type: "CHAT_STREAM_CHUNK",
            url,
            messageId,
            text: accumulated,
          });
        },
      });

      chrome.runtime.sendMessage({
        type: "CHAT_MESSAGE_DONE",
        url,
        messageId,
        text: accumulated,
      });

      sendResponse({ ok: true });
    } catch (err) {
      const errorText = err instanceof Error ? err.message : "Unknown error";
      try {
        if (isObject(message) && typeof message.messageId === "string" && typeof message.url === "string") {
          chrome.runtime.sendMessage({
            type: "CHAT_MESSAGE_ERROR",
            url: message.url,
            messageId: message.messageId,
            error: errorText,
          });
        }
      } catch {
        // ignore secondary errors
      }
      sendResponse({ ok: false, error: errorText });
    }
  })();

  return true;
});

console.log("[Offscreen] Ready");

