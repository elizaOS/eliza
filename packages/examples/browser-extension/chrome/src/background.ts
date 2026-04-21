/**
 * Background Service Worker
 *
 * Handles communication between the popup and content scripts,
 * manages extension state, context menus, and screenshot capture.
 */

import type { ExtensionConfig, PageContent } from "../../shared/types";
import { deepMergeConfig, DEFAULT_CONFIG } from "../../shared/types";

// Storage keys
const CONFIG_STORAGE_KEY = "elizaos-extension-config";
const CONTEXT_TEXT_KEY = "elizaos-context-text";
const CHAT_HISTORY_KEY = "elizaos-chat-history";

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: number;
};

type ChatEvent =
  | { type: "CHAT_STREAM_CHUNK"; url: string; messageId: string; text: string }
  | { type: "CHAT_MESSAGE_DONE"; url: string; messageId: string; text: string }
  | { type: "CHAT_MESSAGE_ERROR"; url: string; messageId: string; error: string };

const portsByUrl = new Map<string, chrome.runtime.Port>();

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function ensureOffscreenDocument(): Promise<boolean> {
  // Safari (and some Chromium) may not support offscreen documents.
  if (!("offscreen" in chrome) || !chrome.offscreen) return false;

  try {
    // If already created, ping it.
    const ping = await chrome.runtime.sendMessage({ type: "OFFSCREEN_PING" });
    if (ping && typeof ping === "object" && "ok" in ping) return true;
  } catch {
    // Not created yet.
  }

  try {
    const offscreenApi = chrome.offscreen as unknown as {
      createDocument: (options: {
        url: string;
        reasons: string[];
        justification: string;
      }) => Promise<void>;
    };
    await offscreenApi.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_SCRAPING"],
      justification: "Keep ElizaOS runtime running for streaming while popup is closed",
    });
    return true;
  } catch (e) {
    console.error("[ElizaOS Background] Offscreen create failed:", e);
    return false;
  }
}

async function getChatHistory(url: string): Promise<StoredMessage[]> {
  const result = await chrome.storage.local.get(CHAT_HISTORY_KEY);
  const all = (result[CHAT_HISTORY_KEY] as Record<string, StoredMessage[]>) || {};
  return all[url] || [];
}

async function setChatHistory(url: string, messages: StoredMessage[]): Promise<void> {
  const result = await chrome.storage.local.get(CHAT_HISTORY_KEY);
  const all = (result[CHAT_HISTORY_KEY] as Record<string, StoredMessage[]>) || {};
  all[url] = messages;
  await chrome.storage.local.set({ [CHAT_HISTORY_KEY]: all });
}

async function clearChatHistoryForUrl(url: string): Promise<void> {
  const result = await chrome.storage.local.get(CHAT_HISTORY_KEY);
  const all = (result[CHAT_HISTORY_KEY] as Record<string, StoredMessage[]>) || {};
  delete all[url];
  await chrome.storage.local.set({ [CHAT_HISTORY_KEY]: all });
}

async function appendChatStart(url: string, messageId: string, userText: string): Promise<void> {
  const now = Date.now();
  const history = await getChatHistory(url);
  history.push({ id: `${messageId}:user`, role: "user", text: userText, timestamp: now });
  history.push({ id: `${messageId}:assistant`, role: "assistant", text: "", timestamp: now });
  await setChatHistory(url, history);
}

async function updateAssistantText(url: string, messageId: string, text: string): Promise<void> {
  const history = await getChatHistory(url);
  const target = `${messageId}:assistant`;
  const idx = history.findIndex((m) => m.id === target);
  if (idx >= 0) {
    history[idx] = { ...history[idx], text };
    await setChatHistory(url, history);
  }
}

function forwardToPopup(url: string, evt: ChatEvent): void {
  const port = portsByUrl.get(url);
  if (!port) return;
  try {
    port.postMessage(evt);
  } catch {
    // ignore
  }
}

// ============================================
// Config Management
// ============================================

async function getConfig(): Promise<ExtensionConfig> {
  try {
    const result = await chrome.storage.local.get(CONFIG_STORAGE_KEY);
    if (result[CONFIG_STORAGE_KEY]) {
      return deepMergeConfig(DEFAULT_CONFIG, result[CONFIG_STORAGE_KEY] as Partial<ExtensionConfig>);
    }
  } catch (error) {
    console.error("[ElizaOS Background] Error getting config:", error);
  }
  return DEFAULT_CONFIG;
}

async function setConfig(config: ExtensionConfig): Promise<void> {
  try {
    await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: config });
  } catch (error) {
    console.error("[ElizaOS Background] Error saving config:", error);
  }
}

// ============================================
// Page Content Extraction
// ============================================

async function getPageContentFromActiveTab(): Promise<PageContent | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id) {
      console.warn("[ElizaOS Background] No active tab found");
      return null;
    }

    // Check if we can inject into this tab
    if (!tab.url || tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://")) {
      console.warn("[ElizaOS Background] Cannot extract content from:", tab.url);
      return null;
    }

    // Try to send message to content script
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_CONTENT" });
      if (response?.content) {
        return response.content as PageContent;
      }
    } catch {
      // Content script might not be loaded, try injecting it
      console.log("[ElizaOS Background] Injecting content script...");
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["dist/content.global.js"],
      });

      // Wait a moment for script to initialize
      await new Promise(resolve => setTimeout(resolve, 100));

      // Try again
      const response = await chrome.tabs.sendMessage(tab.id, { type: "GET_PAGE_CONTENT" });
      if (response?.content) {
        return response.content as PageContent;
      }
    }
  } catch (error) {
    console.error("[ElizaOS Background] Error getting page content:", error);
  }
  return null;
}

// ============================================
// Screenshot Capture
// ============================================

async function captureScreenshot(): Promise<string | null> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({
      format: "jpeg",
      quality: 80,
    });
    return dataUrl;
  } catch (error) {
    console.error("[ElizaOS Background] Screenshot capture failed:", error);
    return null;
  }
}

// ============================================
// Context Menu
// ============================================

function setupContextMenu(): void {
  // Remove existing menu items first
  chrome.contextMenus.removeAll(() => {
    // Add "Chat about this" context menu
    chrome.contextMenus.create({
      id: "elizaos-chat-about-selection",
      title: "Chat about this with ElizaOS",
      contexts: ["selection"],
    });

    chrome.contextMenus.create({
      id: "elizaos-chat-about-page",
      title: "Chat about this page",
      contexts: ["page"],
    });

    chrome.contextMenus.create({
      id: "elizaos-chat-about-link",
      title: "Chat about this link",
      contexts: ["link"],
    });

    chrome.contextMenus.create({
      id: "elizaos-chat-about-image",
      title: "Describe this image",
      contexts: ["image"],
    });
  });
}

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  let contextText = "";
  let contextType = "page";

  if (info.menuItemId === "elizaos-chat-about-selection" && info.selectionText) {
    contextText = info.selectionText;
    contextType = "selection";
  } else if (info.menuItemId === "elizaos-chat-about-link" && info.linkUrl) {
    contextText = `Link: ${info.linkUrl}`;
    contextType = "link";
  } else if (info.menuItemId === "elizaos-chat-about-image" && info.srcUrl) {
    contextText = `Image: ${info.srcUrl}`;
    contextType = "image";
  } else if (info.menuItemId === "elizaos-chat-about-page") {
    contextType = "page";
  }

  // Store context for popup to use
  await chrome.storage.local.set({
    [CONTEXT_TEXT_KEY]: {
      text: contextText,
      type: contextType,
      url: info.pageUrl,
      timestamp: Date.now(),
    },
  });

  // Open the popup (this will trigger the popup to read the context)
  if (tab?.id) {
    try {
      await chrome.action.openPopup();
    } catch {
      // openPopup() might not work in all contexts, fall back to notification
      console.log("[ElizaOS Background] Could not open popup automatically");
    }
  }
});

// ============================================
// Message Handlers
// ============================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  (async () => {
    try {
      // Stream events coming from offscreen -> persist + forward
      if (request?.type === "CHAT_STREAM_CHUNK" || request?.type === "CHAT_MESSAGE_DONE" || request?.type === "CHAT_MESSAGE_ERROR") {
        const evt = request as ChatEvent;
        if (evt.type === "CHAT_STREAM_CHUNK") {
          await updateAssistantText(evt.url, evt.messageId, evt.text);
          forwardToPopup(evt.url, evt);
          sendResponse({ ok: true });
          return;
        }
        if (evt.type === "CHAT_MESSAGE_DONE") {
          await updateAssistantText(evt.url, evt.messageId, evt.text);
          forwardToPopup(evt.url, evt);
          sendResponse({ ok: true });
          return;
        }
        if (evt.type === "CHAT_MESSAGE_ERROR") {
          forwardToPopup(evt.url, evt);
          sendResponse({ ok: true });
          return;
        }
      }

      switch (request.type) {
        case "GET_PAGE_CONTENT": {
          const content = await getPageContentFromActiveTab();
          sendResponse({ type: "PAGE_CONTENT_RESPONSE", content, success: !!content });
          break;
        }

        case "GET_CONFIG": {
          const config = await getConfig();
          sendResponse({ type: "CONFIG_RESPONSE", config });
          break;
        }

        case "SET_CONFIG": {
          await setConfig(request.config);
          sendResponse({ type: "CONFIG_RESPONSE", config: request.config });
          break;
        }

        case "CAPTURE_SCREENSHOT": {
          const dataUrl = await captureScreenshot();
          sendResponse({ type: "SCREENSHOT_RESPONSE", dataUrl, success: !!dataUrl });
          break;
        }

        case "GET_CONTEXT_TEXT": {
          const result = await chrome.storage.local.get(CONTEXT_TEXT_KEY);
          const contextData = result[CONTEXT_TEXT_KEY];
          // Clear the context after reading (one-time use)
          await chrome.storage.local.remove(CONTEXT_TEXT_KEY);
          sendResponse({ type: "CONTEXT_TEXT_RESPONSE", contextData });
          break;
        }

        case "SEND_CHAT_MESSAGE": {
          const url = typeof request.url === "string" ? request.url : "";
          const userText = typeof request.userText === "string" ? request.userText : "";
          const pageContent = (request.pageContent as PageContent | null) || null;

          if (!url || !userText) {
            sendResponse({ ok: false, error: "Missing url or userText" });
            break;
          }

          const offscreenOk = await ensureOffscreenDocument();
          if (!offscreenOk) {
            // Fallback: popup can run inference locally (Safari / unsupported)
            sendResponse({ ok: false, unsupported: true });
            break;
          }

          const config = await getConfig();
          const messageId = newId();

          // Persist immediately so reopening popup shows in-flight state.
          await appendChatStart(url, messageId, userText);

          // Forward to offscreen to actually run inference/streaming.
          await chrome.runtime.sendMessage({
            type: "OFFSCREEN_SEND_CHAT",
            messageId,
            url,
            userText,
            config,
            pageContent,
          });

          sendResponse({ ok: true, messageId });
          break;
        }

        case "RESET_CHAT": {
          const url = typeof request.url === "string" ? request.url : "";
          if (!url) {
            sendResponse({ ok: false, error: "Missing url" });
            break;
          }

          const offscreenOk = await ensureOffscreenDocument();
          if (offscreenOk) {
            try {
              await chrome.runtime.sendMessage({ type: "OFFSCREEN_RESET" });
            } catch (e) {
              console.warn("[ElizaOS Background] Offscreen reset failed:", e);
            }
          }

          await clearChatHistoryForUrl(url);
          sendResponse({ ok: true });
          break;
        }

        case "CONTENT_SCRIPT_READY": {
          console.log("[ElizaOS Background] Content script ready on:", request.url);
          sendResponse({ type: "ACK" });
          break;
        }

        default:
          sendResponse({ error: "Unknown message type" });
      }
    } catch (error) {
      console.error("[ElizaOS Background] Error handling message:", error);
      sendResponse({ error: error instanceof Error ? error.message : "Unknown error" });
    }
  })();

  return true; // Keep channel open for async response
});

// ============================================
// Extension Lifecycle
// ============================================

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;

  let subscribedUrl = "";

  port.onMessage.addListener((msg: unknown) => {
    if (typeof msg !== "object" || msg === null) return;
    const m = msg as { type?: unknown; url?: unknown };
    if (m.type === "SUBSCRIBE_CHAT" && typeof m.url === "string") {
      subscribedUrl = m.url;
      portsByUrl.set(subscribedUrl, port);
      port.postMessage({
        type: "SUBSCRIBE_ACK",
        url: subscribedUrl,
        offscreenSupported: "offscreen" in chrome && !!chrome.offscreen,
      });
    }
  });

  port.onDisconnect.addListener(() => {
    if (subscribedUrl) {
      const current = portsByUrl.get(subscribedUrl);
      if (current === port) portsByUrl.delete(subscribedUrl);
    }
  });
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    console.log("[ElizaOS Background] Extension installed");
    setConfig(DEFAULT_CONFIG);
  } else if (details.reason === "update") {
    console.log("[ElizaOS Background] Extension updated from", details.previousVersion);
  }
  
  // Setup context menu
  setupContextMenu();
});

// Setup context menu on startup
chrome.runtime.onStartup.addListener(() => {
  setupContextMenu();
});

// Initialize context menu
setupContextMenu();

console.log("[ElizaOS Background] Service worker started");
