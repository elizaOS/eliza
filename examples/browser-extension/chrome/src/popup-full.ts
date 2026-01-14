/**
 * Full Popup Script with ElizaOS Runtime
 * 
 * Supports multiple LLM providers and uses localdb for persistence
 */

console.log("[Popup] Script loading...");

// Global error handlers
window.onerror = (message, source, lineno, colno, error) => {
  console.error("[Popup] Global error:", { message, source, lineno, colno, error });
  return false;
};

window.onunhandledrejection = (event) => {
  console.error("[Popup] Unhandled rejection:", event.reason);
};

import {
  getOrCreateRuntime,
  getGreetingText,
  resetConversation,
  sendMessage,
  updatePageContent,
  updateSelectedText,
  updateScreenshot,
  getScreenshot,
  clearScreenshot,
  resolveEffectiveMode,
} from "../../shared/eliza-runtime-full";
import {
  deepMergeConfig,
  DEFAULT_CONFIG,
  type ExtensionConfig,
  type PageContent,
  type ProviderMode,
} from "../../shared/types";

console.log("[Popup] Imports loaded");

// ============================================
// DOM Elements
// ============================================

const elements = {
  statusDot: document.getElementById("statusDot") as HTMLDivElement,
  statusText: document.getElementById("statusText") as HTMLSpanElement,
  pageTitle: document.getElementById("pageTitle") as HTMLDivElement,
  pageUrl: document.getElementById("pageUrl") as HTMLDivElement,
  messages: document.getElementById("messages") as HTMLDivElement,
  messageForm: document.getElementById("messageForm") as HTMLFormElement,
  messageInput: document.getElementById("messageInput") as HTMLInputElement,
  sendBtn: document.getElementById("sendBtn") as HTMLButtonElement,
  clearChatBtn: document.getElementById("clearChatBtn") as HTMLButtonElement,
  settingsBtn: document.getElementById("settingsBtn") as HTMLButtonElement,
  settingsModal: document.getElementById("settingsModal") as HTMLDivElement,
  closeSettingsBtn: document.getElementById("closeSettingsBtn") as HTMLButtonElement,
  providerSelect: document.getElementById("providerSelect") as HTMLSelectElement,
  providerNote: document.getElementById("providerNote") as HTMLDivElement,
  // Context indicators
  selectionBadge: document.getElementById("selectionBadge") as HTMLSpanElement,
  screenshotBadge: document.getElementById("screenshotBadge") as HTMLSpanElement,
  screenshotBtn: document.getElementById("screenshotBtn") as HTMLButtonElement,
  includeScreenshots: document.getElementById("includeScreenshots") as HTMLInputElement,
  // Individual provider settings sections
  openaiSettings: document.getElementById("openaiSettings") as HTMLDivElement,
  anthropicSettings: document.getElementById("anthropicSettings") as HTMLDivElement,
  xaiSettings: document.getElementById("xaiSettings") as HTMLDivElement,
  geminiSettings: document.getElementById("geminiSettings") as HTMLDivElement,
  groqSettings: document.getElementById("groqSettings") as HTMLDivElement,
  // API key inputs
  openaiApiKey: document.getElementById("openaiApiKey") as HTMLInputElement,
  anthropicApiKey: document.getElementById("anthropicApiKey") as HTMLInputElement,
  xaiApiKey: document.getElementById("xaiApiKey") as HTMLInputElement,
  geminiApiKey: document.getElementById("geminiApiKey") as HTMLInputElement,
  groqApiKey: document.getElementById("groqApiKey") as HTMLInputElement,
};

// ============================================
// State
// ============================================

let config: ExtensionConfig = { ...DEFAULT_CONFIG };
let pageContent: PageContent | null = null;
let sending = false;
let screenshotEnabled = false;
let contextText: string | null = null; // From right-click context menu
let currentPageUrl: string = ""; // For persisting chat per URL
let useBackgroundInference = false;
let popupPort: chrome.runtime.Port | null = null;
const assistantDivByMessageId = new Map<string, HTMLDivElement>();

// Chat message type for storage
interface StoredMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: number;
}

// ============================================
// Storage Keys
// ============================================

const CONFIG_KEY = "elizaos-extension-config";
const CHAT_HISTORY_KEY = "elizaos-chat-history"; // Stores { [url]: StoredMessage[] }

async function loadConfig(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(CONFIG_KEY);
    if (result[CONFIG_KEY]) {
      config = deepMergeConfig(DEFAULT_CONFIG, result[CONFIG_KEY] as Partial<ExtensionConfig>);
    }
  } catch (e) {
    console.error("[Popup] Error loading config:", e);
  }
}

async function saveConfig(): Promise<void> {
  try {
    await chrome.storage.local.set({ [CONFIG_KEY]: config });
  } catch (e) {
    console.error("[Popup] Error saving config:", e);
  }
}

// ============================================
// Chat History Storage
// ============================================

async function loadChatHistory(): Promise<StoredMessage[]> {
  if (!currentPageUrl) return [];
  
  try {
    const result = await chrome.storage.local.get(CHAT_HISTORY_KEY);
    const allHistory = result[CHAT_HISTORY_KEY] as Record<string, StoredMessage[]> | undefined;
    if (allHistory && allHistory[currentPageUrl]) {
      console.log("[Popup] Loaded chat history for", currentPageUrl, ":", allHistory[currentPageUrl].length, "messages");
      return allHistory[currentPageUrl];
    }
  } catch (e) {
    console.error("[Popup] Error loading chat history:", e);
  }
  return [];
}

async function saveChatHistory(messages: StoredMessage[]): Promise<void> {
  if (!currentPageUrl) return;
  
  try {
    const result = await chrome.storage.local.get(CHAT_HISTORY_KEY);
    const allHistory = (result[CHAT_HISTORY_KEY] as Record<string, StoredMessage[]>) || {};
    allHistory[currentPageUrl] = messages;
    await chrome.storage.local.set({ [CHAT_HISTORY_KEY]: allHistory });
  } catch (e) {
    console.error("[Popup] Error saving chat history:", e);
  }
}

async function clearChatHistory(): Promise<void> {
  if (!currentPageUrl) return;
  
  try {
    const result = await chrome.storage.local.get(CHAT_HISTORY_KEY);
    const allHistory = (result[CHAT_HISTORY_KEY] as Record<string, StoredMessage[]>) || {};
    delete allHistory[currentPageUrl];
    await chrome.storage.local.set({ [CHAT_HISTORY_KEY]: allHistory });
    console.log("[Popup] Cleared chat history for", currentPageUrl);
  } catch (e) {
    console.error("[Popup] Error clearing chat history:", e);
  }
}

function getMessagesFromDOM(): StoredMessage[] {
  const messageElements = elements.messages.querySelectorAll(".message");
  const messages: StoredMessage[] = [];
  
  messageElements.forEach((el) => {
    const isUser = el.classList.contains("user");
    const text = el.textContent || "";
    messages.push({
      role: isUser ? "user" : "assistant",
      text,
      timestamp: Date.now(),
    });
  });
  
  return messages;
}

// ============================================
// UI Helpers
// ============================================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function preprocessAssistantText(text: string): string {
  // Convert common HTML line breaks into newlines so the markdown renderer can handle them.
  return text.replace(/<br\s*\/?>/gi, "\n");
}

function renderMarkdownToSafeHtml(markdown: string): string {
  const preprocessed = preprocessAssistantText(markdown);
  const escaped = escapeHtml(preprocessed);

  // Code blocks ```lang\n...\n```
  const withCodeBlocks = escaped.replace(
    /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g,
    (_match, _lang, code) => `<pre><code>${code}</code></pre>`,
  );

  // Inline code `code`
  const withInlineCode = withCodeBlocks.replace(/`([^`\n]+)`/g, (_m, code) => `<code>${code}</code>`);

  // Bold **text**
  const withBold = withInlineCode.replace(/\*\*([^*\n]+)\*\*/g, (_m, t) => `<strong>${t}</strong>`);

  // Italic *text* (avoid matching bold)
  const withItalic = withBold.replace(/(^|[^*])\*([^*\n]+)\*/g, (_m, lead, t) => `${lead}<em>${t}</em>`);

  // Links [text](url)
  const withLinks = withItalic.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });

  // Newlines -> <br>
  return withLinks.replace(/\n/g, "<br>");
}

function setMessageContent(msgDiv: HTMLDivElement, role: "user" | "assistant", text: string): void {
  if (role === "assistant") {
    msgDiv.innerHTML = renderMarkdownToSafeHtml(text);
  } else {
    msgDiv.textContent = text;
  }
}

function getModeLabel(mode: ProviderMode): string {
  const labels: Record<ProviderMode, string> = {
    elizaClassic: "ELIZA Classic",
    openai: "OpenAI",
    anthropic: "Claude",
    xai: "Grok",
    gemini: "Gemini",
    groq: "Groq",
  };
  return labels[mode] || mode;
}

function updateStatus(mode: ProviderMode, ready: boolean): void {
  elements.statusText.textContent = getModeLabel(mode);
  elements.statusDot.className = ready ? "status-dot active" : "status-dot";
}

function updatePageInfo(content: PageContent | null): void {
  if (content) {
    elements.pageTitle.textContent = content.title || "Untitled";
    elements.pageUrl.textContent = content.url || "";
    elements.pageUrl.title = content.url || "";
    
    // Update context indicators
    if (content.selectedText || contextText) {
      elements.selectionBadge.style.display = "inline-flex";
    } else {
      elements.selectionBadge.style.display = "none";
    }
  } else {
    elements.pageTitle.textContent = "No page loaded";
    elements.pageUrl.textContent = "";
    elements.selectionBadge.style.display = "none";
  }
  
  // Screenshot indicator
  updateScreenshotIndicator();
}

function updateScreenshotIndicator(): void {
  if (screenshotEnabled && getScreenshot()) {
    elements.screenshotBadge.style.display = "inline-flex";
    elements.screenshotBtn.classList.add("active");
  } else {
    elements.screenshotBadge.style.display = "none";
    elements.screenshotBtn.classList.remove("active");
  }
}

async function captureAndUpdateScreenshot(): Promise<void> {
  if (!screenshotEnabled) {
    clearScreenshot();
    updateScreenshotIndicator();
    return;
  }
  
  try {
    const response = await new Promise<{ dataUrl?: string; success?: boolean }>((resolve) => {
      chrome.runtime.sendMessage({ type: "CAPTURE_SCREENSHOT" }, resolve);
    });
    
    if (response?.success && response.dataUrl) {
      updateScreenshot(response.dataUrl);
      console.log("[Popup] Screenshot captured");
    }
  } catch (error) {
    console.error("[Popup] Screenshot capture failed:", error);
  }
  
  updateScreenshotIndicator();
}

function toggleScreenshot(): void {
  screenshotEnabled = !screenshotEnabled;
  if (screenshotEnabled) {
    captureAndUpdateScreenshot();
  } else {
    clearScreenshot();
    updateScreenshotIndicator();
  }
}

function addMessage(role: "user" | "assistant", text: string, save = true): HTMLDivElement {
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${role}`;
  setMessageContent(msgDiv, role, text);
  elements.messages.appendChild(msgDiv);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  
  // Save chat history after adding a message
  if (save && !useBackgroundInference) {
    saveChatHistory(getMessagesFromDOM());
  }
  
  return msgDiv;
}

function updateMessage(msgDiv: HTMLDivElement, text: string, save = true): void {
  const role: "user" | "assistant" = msgDiv.classList.contains("user") ? "user" : "assistant";
  setMessageContent(msgDiv, role, text);
  elements.messages.scrollTop = elements.messages.scrollHeight;
  
  // Save chat history after updating a message
  if (save && !useBackgroundInference) {
    saveChatHistory(getMessagesFromDOM());
  }
}

function restoreMessages(messages: StoredMessage[]): void {
  elements.messages.innerHTML = "";
  for (const msg of messages) {
    addMessage(msg.role, msg.text, false); // Don't re-save while restoring
  }
}

// ============================================
// Settings UI
// ============================================

const providerSettingsSections: Record<ProviderMode, HTMLDivElement | null> = {
  elizaClassic: null,
  openai: elements.openaiSettings,
  anthropic: elements.anthropicSettings,
  xai: elements.xaiSettings,
  gemini: elements.geminiSettings,
  groq: elements.groqSettings,
};

function updateProviderSettings(): void {
  // Hide all provider settings sections (remove active class)
  Object.values(providerSettingsSections).forEach((section) => {
    if (section) section.classList.remove("active");
  });
  
  // Show the selected provider's settings (add active class)
  const activeSection = providerSettingsSections[config.mode];
  if (activeSection) {
    activeSection.classList.add("active");
  }
  
  // Update the provider note
  const effectiveMode = resolveEffectiveMode(config);
  const noteText = elements.providerNote?.querySelector(".note-text");
  const noteDot = elements.providerNote?.querySelector(".dot") as HTMLElement;
  
  if (noteText && noteDot) {
    if (config.mode === "elizaClassic") {
      noteText.textContent = "ELIZA Classic works offline - no API key needed";
      noteDot.style.background = "#22c55e";
    } else if (effectiveMode === "elizaClassic") {
      noteText.textContent = "No API key set - will use ELIZA Classic fallback";
      noteDot.style.background = "#eab308";
    } else {
      noteText.textContent = "API key configured";
      noteDot.style.background = "#22c55e";
    }
  }
}

function loadApiKeysIntoForm(): void {
  // Populate form fields with saved values
  if (elements.openaiApiKey) elements.openaiApiKey.value = config.provider.openaiApiKey || "";
  if (elements.anthropicApiKey) elements.anthropicApiKey.value = config.provider.anthropicApiKey || "";
  if (elements.xaiApiKey) elements.xaiApiKey.value = config.provider.xaiApiKey || "";
  if (elements.geminiApiKey) elements.geminiApiKey.value = config.provider.googleGenaiApiKey || "";
  if (elements.groqApiKey) elements.groqApiKey.value = config.provider.groqApiKey || "";
}

function setupApiKeyListeners(): void {
  // OpenAI
  elements.openaiApiKey?.addEventListener("input", () => {
    config.provider.openaiApiKey = elements.openaiApiKey.value;
    saveConfig();
    updateProviderSettings();
  });
  
  // Anthropic
  elements.anthropicApiKey?.addEventListener("input", () => {
    config.provider.anthropicApiKey = elements.anthropicApiKey.value;
    saveConfig();
    updateProviderSettings();
  });
  
  // xAI
  elements.xaiApiKey?.addEventListener("input", () => {
    config.provider.xaiApiKey = elements.xaiApiKey.value;
    saveConfig();
    updateProviderSettings();
  });
  
  // Gemini (note: HTML uses geminiApiKey, config uses googleGenaiApiKey)
  elements.geminiApiKey?.addEventListener("input", () => {
    config.provider.googleGenaiApiKey = elements.geminiApiKey.value;
    saveConfig();
    updateProviderSettings();
  });
  
  // Groq
  elements.groqApiKey?.addEventListener("input", () => {
    config.provider.groqApiKey = elements.groqApiKey.value;
    saveConfig();
    updateProviderSettings();
  });
}

function openSettings(): void {
  elements.providerSelect.value = config.mode;
  loadApiKeysIntoForm();
  updateProviderSettings();
  
  // Sync screenshot checkbox
  if (elements.includeScreenshots) {
    elements.includeScreenshots.checked = screenshotEnabled;
  }
  
  elements.settingsModal.classList.add("open");
}

function closeSettings(): void {
  elements.settingsModal.classList.remove("open");
  // Reinitialize runtime with new settings
  initializeRuntime();
}

// ============================================
// Page Content
// ============================================

async function checkContextMenuInput(): Promise<void> {
  try {
    const response = await new Promise<{ contextData?: { text: string; type: string; url: string } }>((resolve) => {
      chrome.runtime.sendMessage({ type: "GET_CONTEXT_TEXT" }, resolve);
    });
    
    if (response?.contextData?.text) {
      contextText = response.contextData.text;
      updateSelectedText(contextText);
      console.log("[Popup] Got context menu text:", contextText.substring(0, 50));
    }
  } catch (error) {
    console.error("[Popup] Error checking context menu:", error);
  }
}

async function fetchPageContent(): Promise<void> {
  console.log("[Popup] Fetching page content...");
  
  // Also check for context menu input
  await checkContextMenuInput();
  
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      console.log("[Popup] Page content fetch timed out");
      resolve();
    }, 5000);
    
    chrome.runtime.sendMessage({ type: "GET_PAGE_CONTENT" }, (response) => {
      clearTimeout(timeout);
      console.log("[Popup] Got response:", response);
      
      if (chrome.runtime.lastError) {
        console.error("[Popup] Error:", chrome.runtime.lastError);
        resolve();
        return;
      }
      
      if (response?.content) {
        const content = response.content as PageContent;
        
        // Set current page URL for chat history persistence
        currentPageUrl = content.url || "";
        console.log("[Popup] Current page URL:", currentPageUrl);
        
        // If we have context menu text, add it to selected text
        if (contextText && !content.selectedText) {
          content.selectedText = contextText;
        }
        
        pageContent = content;
        updatePageInfo(content);
        updatePageContent(content);
        
        // Also update selected text separately
        if (content.selectedText) {
          updateSelectedText(content.selectedText);
        }
        
        console.log("[Popup] Page content loaded, selected:", !!content.selectedText);
      } else {
        console.log("[Popup] No page content");
        updatePageInfo(null);
      }
      resolve();
    });
  });
}

function setupBackgroundStreaming(): void {
  if (!currentPageUrl) return;

  try {
    popupPort = chrome.runtime.connect({ name: "popup" });
    useBackgroundInference = true;
    popupPort.postMessage({ type: "SUBSCRIBE_CHAT", url: currentPageUrl });

    popupPort.onMessage.addListener((evt: unknown) => {
      if (typeof evt !== "object" || evt === null) return;
      const e = evt as { type?: unknown; messageId?: unknown; text?: unknown; error?: unknown };

      if (e.type === "CHAT_STREAM_CHUNK" && typeof e.messageId === "string" && typeof e.text === "string") {
        const div = assistantDivByMessageId.get(e.messageId);
        if (div) updateMessage(div, e.text, false);
        return;
      }

      if (e.type === "CHAT_MESSAGE_DONE" && typeof e.messageId === "string" && typeof e.text === "string") {
        const div = assistantDivByMessageId.get(e.messageId);
        if (div) updateMessage(div, e.text, false);
        return;
      }

      if (e.type === "CHAT_MESSAGE_ERROR" && typeof e.messageId === "string") {
        const div = assistantDivByMessageId.get(e.messageId);
        const errorText = typeof e.error === "string" ? e.error : "Unknown error";
        if (div) updateMessage(div, `Error: ${errorText}`, false);
      }
    });

    popupPort.onDisconnect.addListener(() => {
      popupPort = null;
      // If user reopens, we reconnect in initialize().
    });
  } catch (e) {
    console.warn("[Popup] Background streaming not available:", e);
    popupPort = null;
    useBackgroundInference = false;
  }
}

// ============================================
// Message Handling
// ============================================

async function handleSendMessage(text: string): Promise<void> {
  if (sending || !text.trim()) return;
  
  sending = true;
  elements.sendBtn.disabled = true;
  elements.messageInput.disabled = true;
  
  addMessage("user", text, false);
  elements.messageInput.value = "";
  
  const assistantMsg = addMessage("assistant", "...", false);
  
  try {
    // Capture fresh screenshot if enabled (will dedupe if same as last)
    if (screenshotEnabled) {
      await captureAndUpdateScreenshot();
    }
    
    const effectiveMode = resolveEffectiveMode(config);
    
    // Prefer background/offscreen inference so it can continue if popup closes.
    if (useBackgroundInference && currentPageUrl) {
      const resp = await new Promise<{ ok?: boolean; unsupported?: boolean; messageId?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { type: "SEND_CHAT_MESSAGE", url: currentPageUrl, userText: text, pageContent },
          resolve,
        );
      });

      if (resp?.ok && typeof resp.messageId === "string") {
        assistantDivByMessageId.set(resp.messageId, assistantMsg);
        // Background will stream updates; keep placeholder for now.
        return;
      }
    }

    // Fallback: inference in popup (Safari / unsupported) — will stop if popup closes.
    if (effectiveMode === "elizaClassic") {
      const { responseText } = await sendMessage(config, text);
      updateMessage(assistantMsg, responseText, true);
    } else {
      let fullText = "";
      await sendMessage(config, text, {
        onAssistantChunk: (chunk) => {
          fullText += chunk;
          updateMessage(assistantMsg, fullText, true);
        },
      });
      if (!fullText) {
        const { responseText } = await sendMessage(config, text);
        updateMessage(assistantMsg, responseText, true);
      }
    }
  } catch (error) {
    console.error("[Popup] Error sending message:", error);
    updateMessage(assistantMsg, `Error: ${error instanceof Error ? error.message : "Unknown error"}`);
  } finally {
    sending = false;
    elements.sendBtn.disabled = false;
    elements.messageInput.disabled = false;
    elements.messageInput.focus();
  }
}

async function handleClearChat(): Promise<void> {
  try {
    if (useBackgroundInference && currentPageUrl) {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "RESET_CHAT", url: currentPageUrl }, resolve);
      });
    } else {
      await resetConversation();
    }
  } catch (e) {
    console.error("[Popup] Error resetting conversation:", e);
  }
  
  // Clear stored chat history for this URL
  await clearChatHistory();
  
  elements.messages.innerHTML = "";
  const effectiveMode = resolveEffectiveMode(config);
  addMessage("assistant", getGreetingText(effectiveMode));
}

// ============================================
// Initialization
// ============================================

async function initializeRuntime(): Promise<void> {
  const effectiveMode = resolveEffectiveMode(config);
  updateStatus(effectiveMode, false);
  
  try {
    if (useBackgroundInference) {
      // Runtime lives in offscreen; popup is just UI.
      updateStatus(effectiveMode, true);
      return;
    }
    console.log("[Popup] Initializing runtime with mode:", effectiveMode);
    await getOrCreateRuntime(config);
    console.log("[Popup] Runtime initialized");
    updateStatus(effectiveMode, true);
  } catch (error) {
    console.error("[Popup] Error initializing runtime:", error);
    updateStatus(effectiveMode, false);
    elements.statusText.textContent = "Error";
  }
}

async function initialize(): Promise<void> {
  console.log("[Popup] Starting initialization...");
  
  // Load config
  await loadConfig();
  console.log("[Popup] Config loaded, mode:", config.mode);
  
  // Setup provider select and API key listeners
  elements.providerSelect.value = config.mode;
  setupApiKeyListeners();
  loadApiKeysIntoForm();
  updateProviderSettings();
  
  // Fetch page content (this also sets currentPageUrl)
  await fetchPageContent();

  // Connect to background streaming (so inference continues if popup closes)
  setupBackgroundStreaming();
  
  // Initialize runtime
  await initializeRuntime();
  
  // Enable inputs
  elements.messageInput.disabled = false;
  elements.sendBtn.disabled = false;
  elements.messageInput.focus();
  
  // Load saved chat history for this URL, or show greeting if none
  const savedMessages = await loadChatHistory();
  if (savedMessages.length > 0) {
    restoreMessages(savedMessages);
    console.log("[Popup] Restored", savedMessages.length, "messages from history");
  } else {
    // Show greeting for new conversation
    const effectiveMode = resolveEffectiveMode(config);
    addMessage("assistant", getGreetingText(effectiveMode));
  }
  
  console.log("[Popup] Initialization complete");
}

// ============================================
// Event Listeners
// ============================================

elements.messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = elements.messageInput.value.trim();
  if (text) {
    handleSendMessage(text);
  }
});

elements.clearChatBtn.addEventListener("click", () => {
  handleClearChat();
});

elements.settingsBtn.addEventListener("click", () => {
  openSettings();
});

elements.closeSettingsBtn.addEventListener("click", () => {
  closeSettings();
});

elements.settingsModal.addEventListener("click", (e) => {
  if (e.target === elements.settingsModal) {
    closeSettings();
  }
});

elements.providerSelect.addEventListener("change", () => {
  config.mode = elements.providerSelect.value as ProviderMode;
  saveConfig();
  updateProviderSettings();
});

// Screenshot toggle
elements.screenshotBtn?.addEventListener("click", () => {
  toggleScreenshot();
});

// Screenshot checkbox in settings
elements.includeScreenshots?.addEventListener("change", () => {
  screenshotEnabled = elements.includeScreenshots.checked;
  if (screenshotEnabled) {
    captureAndUpdateScreenshot();
  } else {
    clearScreenshot();
    updateScreenshotIndicator();
  }
});

// ============================================
// Start
// ============================================

console.log("[Popup] Setting up initialization...");
initialize().catch((error) => {
  console.error("[Popup] Initialize failed:", error);
  elements.statusText.textContent = "Error";
  elements.messageInput.disabled = false;
  elements.sendBtn.disabled = false;
  addMessage("assistant", `Initialization error: ${error instanceof Error ? error.message : "Unknown"}`);
});
