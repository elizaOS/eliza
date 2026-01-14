/**
 * Popup Script
 *
 * Handles the chat UI, settings management, and communication
 * with the Eliza runtime.
 */

// Global error handler to catch module loading errors
window.onerror = (message, source, lineno, colno, error) => {
  console.error("[Popup] Global error:", { message, source, lineno, colno, error });
  const statusEl = document.getElementById("statusText");
  if (statusEl) statusEl.textContent = "Script error - check console";
  return false;
};

window.onunhandledrejection = (event) => {
  console.error("[Popup] Unhandled promise rejection:", event.reason);
};

console.log("[Popup] Script starting...");

import {
  getOrCreateRuntime,
  getGreetingText,
  resetConversation,
  sendMessage,
  updatePageContent,
} from "../../shared/eliza-runtime";
import {
  deepMergeConfig,
  DEFAULT_CONFIG,
  type ExtensionConfig,
  getEffectiveMode,
  getModeLabel,
  hasValidApiKey,
  type PageContent,
  type ProviderMode,
} from "../../shared/types";

console.log("[Popup] Modules imported successfully");

// ============================================
// DOM Elements
// ============================================

const elements = {
  // Header
  statusDot: document.getElementById("statusDot") as HTMLElement,
  statusText: document.getElementById("statusText") as HTMLElement,
  settingsBtn: document.getElementById("settingsBtn") as HTMLButtonElement,

  // Page info
  pageTitle: document.getElementById("pageTitle") as HTMLElement,
  pageUrl: document.getElementById("pageUrl") as HTMLElement,

  // Chat
  chatContainer: document.getElementById("chatContainer") as HTMLElement,
  messages: document.getElementById("messages") as HTMLElement,
  messageForm: document.getElementById("messageForm") as HTMLFormElement,
  messageInput: document.getElementById("messageInput") as HTMLInputElement,
  sendBtn: document.getElementById("sendBtn") as HTMLButtonElement,
  clearChatBtn: document.getElementById("clearChatBtn") as HTMLButtonElement,

  // Settings Modal
  settingsModal: document.getElementById("settingsModal") as HTMLElement,
  closeSettingsBtn: document.getElementById("closeSettingsBtn") as HTMLButtonElement,
  providerSelect: document.getElementById("providerSelect") as HTMLSelectElement,
  providerNote: document.getElementById("providerNote") as HTMLElement,

  // Provider settings
  openaiSettings: document.getElementById("openaiSettings") as HTMLElement,
  openaiApiKey: document.getElementById("openaiApiKey") as HTMLInputElement,
  anthropicSettings: document.getElementById("anthropicSettings") as HTMLElement,
  anthropicApiKey: document.getElementById("anthropicApiKey") as HTMLInputElement,
  xaiSettings: document.getElementById("xaiSettings") as HTMLElement,
  xaiApiKey: document.getElementById("xaiApiKey") as HTMLInputElement,
  geminiSettings: document.getElementById("geminiSettings") as HTMLElement,
  geminiApiKey: document.getElementById("geminiApiKey") as HTMLInputElement,
  groqSettings: document.getElementById("groqSettings") as HTMLElement,
  groqApiKey: document.getElementById("groqApiKey") as HTMLInputElement,
};

// ============================================
// State
// ============================================

let config: ExtensionConfig = { ...DEFAULT_CONFIG };
let pageContent: PageContent | null = null;
let isProcessing = false;

// ============================================
// Storage
// ============================================

const CONFIG_KEY = "elizaos-extension-config";

async function loadConfig(): Promise<void> {
  try {
    const result = await chrome.storage.local.get(CONFIG_KEY);
    if (result[CONFIG_KEY]) {
      config = deepMergeConfig(DEFAULT_CONFIG, result[CONFIG_KEY] as Partial<ExtensionConfig>);
    }
  } catch (error) {
    console.error("[Popup] Error loading config:", error);
  }
}

async function saveConfig(): Promise<void> {
  try {
    await chrome.storage.local.set({ [CONFIG_KEY]: config });
  } catch (error) {
    console.error("[Popup] Error saving config:", error);
  }
}

// ============================================
// UI Updates
// ============================================

function updateStatus(mode: ProviderMode, ready: boolean): void {
  const effectiveMode = getEffectiveMode(config);
  const label = getModeLabel(effectiveMode);

  elements.statusText.textContent = ready ? label : "Initializing...";

  if (!ready) {
    elements.statusDot.className = "status-dot";
  } else if (effectiveMode === "elizaClassic") {
    elements.statusDot.className = "status-dot offline";
  } else {
    elements.statusDot.className = "status-dot online";
  }
}

function updatePageInfo(content: PageContent | null): void {
  if (content) {
    elements.pageTitle.textContent = content.title || "Untitled";
    elements.pageUrl.textContent = content.url || "";
  } else {
    elements.pageTitle.textContent = "No page content available";
    elements.pageUrl.textContent = "Open the extension on a webpage to chat about it";
  }
}

function updateProviderSettings(): void {
  // Hide all provider settings
  document.querySelectorAll(".provider-settings").forEach((el) => {
    el.classList.remove("active");
  });

  // Show settings for selected provider
  const provider = config.mode;
  const settingsEl = document.getElementById(`${provider}Settings`);
  if (settingsEl) {
    settingsEl.classList.add("active");
  }

  // Update provider note
  const effectiveMode = getEffectiveMode(config);
  const hasKey = hasValidApiKey(config);
  const noteEl = elements.providerNote;
  const dotEl = noteEl.querySelector(".dot") as HTMLElement;
  const textEl = noteEl.querySelector(".note-text") as HTMLElement;

  if (config.mode === "elizaClassic") {
    dotEl.className = "dot good";
    textEl.textContent = `Using: ${getModeLabel(effectiveMode)} (no API key needed)`;
  } else if (hasKey) {
    dotEl.className = "dot good";
    textEl.textContent = `Using: ${getModeLabel(effectiveMode)}`;
  } else {
    dotEl.className = "dot warn";
    textEl.textContent = `Using: ${getModeLabel(effectiveMode)} (add API key to use ${getModeLabel(config.mode)})`;
  }
}

function populateSettingsForm(): void {
  elements.providerSelect.value = config.mode;
  elements.openaiApiKey.value = config.provider.openaiApiKey || "";
  elements.anthropicApiKey.value = config.provider.anthropicApiKey || "";
  elements.xaiApiKey.value = config.provider.xaiApiKey || "";
  elements.geminiApiKey.value = config.provider.googleGenaiApiKey || "";
  elements.groqApiKey.value = config.provider.groqApiKey || "";
  updateProviderSettings();
}

function collectSettingsForm(): void {
  config.mode = elements.providerSelect.value as ProviderMode;
  config.provider.openaiApiKey = elements.openaiApiKey.value.trim();
  config.provider.anthropicApiKey = elements.anthropicApiKey.value.trim();
  config.provider.xaiApiKey = elements.xaiApiKey.value.trim();
  config.provider.googleGenaiApiKey = elements.geminiApiKey.value.trim();
  config.provider.groqApiKey = elements.groqApiKey.value.trim();
}

// ============================================
// Messages
// ============================================

function addMessage(role: "user" | "assistant", text: string): HTMLElement {
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${role}`;
  messageDiv.innerHTML = `
    <div class="message-bubble">${escapeHtml(text)}</div>
    <div class="message-time">${formatTime(new Date())}</div>
  `;
  elements.messages.appendChild(messageDiv);
  scrollToBottom();
  return messageDiv;
}

function addTypingIndicator(): HTMLElement {
  const messageDiv = document.createElement("div");
  messageDiv.className = "message assistant";
  messageDiv.id = "typing-indicator";
  messageDiv.innerHTML = `
    <div class="message-bubble">
      <div class="typing-indicator">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </div>
  `;
  elements.messages.appendChild(messageDiv);
  scrollToBottom();
  return messageDiv;
}

function removeTypingIndicator(): void {
  const indicator = document.getElementById("typing-indicator");
  if (indicator) {
    indicator.remove();
  }
}

function updateAssistantMessage(element: HTMLElement, text: string): void {
  const bubble = element.querySelector(".message-bubble");
  if (bubble) {
    bubble.innerHTML = escapeHtml(text);
  }
}

function clearMessages(): void {
  elements.messages.innerHTML = "";
}

function scrollToBottom(): void {
  elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML.replace(/\n/g, "<br>");
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ============================================
// Chat Handling
// ============================================

async function handleSendMessage(text: string): Promise<void> {
  if (!text.trim() || isProcessing) return;

  isProcessing = true;
  elements.messageInput.disabled = true;
  elements.sendBtn.disabled = true;

  // Add user message
  addMessage("user", text);
  elements.messageInput.value = "";

  // Show typing indicator
  addTypingIndicator();

  try {
    // Create assistant message element for streaming
    removeTypingIndicator();
    const assistantEl = addMessage("assistant", "");
    let responseText = "";

    const result = await sendMessage(config, text, {
      onChunk: (chunk) => {
        responseText += chunk;
        updateAssistantMessage(assistantEl, responseText);
        scrollToBottom();
      },
    });

    // If no streaming, update with final result
    if (!responseText && result.responseText) {
      updateAssistantMessage(assistantEl, result.responseText);
    }
  } catch (error) {
    removeTypingIndicator();
    const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
    addMessage("assistant", `Error: ${errorMessage}`);
  } finally {
    isProcessing = false;
    elements.messageInput.disabled = false;
    elements.sendBtn.disabled = false;
    elements.messageInput.focus();
  }
}

async function handleClearChat(): Promise<void> {
  if (isProcessing) return;

  await resetConversation();
  clearMessages();

  // Show greeting
  const effectiveMode = getEffectiveMode(config);
  const greeting = getGreetingText(effectiveMode);
  addMessage("assistant", greeting);
}

// ============================================
// Settings Modal
// ============================================

function openSettings(): void {
  populateSettingsForm();
  elements.settingsModal.classList.add("open");
}

async function closeSettings(): Promise<void> {
  collectSettingsForm();
  await saveConfig();

  elements.settingsModal.classList.remove("open");

  // Update UI
  updateStatus(config.mode, true);
  updateProviderSettings();

  // Re-initialize runtime with new settings
  try {
    await getOrCreateRuntime(config);
    if (pageContent) {
      await updatePageContent(config, pageContent);
    }
  } catch (error) {
    console.error("[Popup] Error reinitializing runtime:", error);
  }
}

// ============================================
// Page Content
// ============================================

async function fetchPageContent(): Promise<void> {
  console.log("[Popup] Fetching page content...");
  try {
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Timeout fetching page content")), 5000);
    });
    
    const messagePromise = chrome.runtime.sendMessage({ type: "GET_PAGE_CONTENT" });
    const response = await Promise.race([messagePromise, timeoutPromise]);
    
    console.log("[Popup] Got response:", response);
    
    if (response?.content) {
      pageContent = response.content;
      updatePageInfo(pageContent);
      // Don't await this - do it in background
      updatePageContent(config, pageContent).catch(err => 
        console.error("[Popup] Error updating runtime page content:", err)
      );
    } else {
      console.log("[Popup] No content in response");
      pageContent = null;
      updatePageInfo(null);
    }
  } catch (error) {
    console.error("[Popup] Error fetching page content:", error);
    pageContent = null;
    updatePageInfo(null);
  }
}

// ============================================
// Initialization
// ============================================

async function initialize(): Promise<void> {
  console.log("[Popup] Starting initialization...");
  
  // Load saved config
  try {
    await loadConfig();
    console.log("[Popup] Config loaded:", config.mode);
  } catch (error) {
    console.error("[Popup] Error loading config:", error);
  }

  // Update UI with initial state
  updateStatus(config.mode, false);
  populateSettingsForm();

  // Fetch page content (don't block on errors)
  try {
    await fetchPageContent();
    console.log("[Popup] Page content fetched:", pageContent?.title || "none");
  } catch (error) {
    console.error("[Popup] Error fetching page content:", error);
    updatePageInfo(null);
  }

  // Initialize runtime
  try {
    console.log("[Popup] Initializing runtime...");
    await getOrCreateRuntime(config);
    console.log("[Popup] Runtime initialized");
    updateStatus(config.mode, true);

    // Enable input
    elements.messageInput.disabled = false;
    elements.sendBtn.disabled = false;
    elements.messageInput.focus();

    // Show greeting
    const effectiveMode = getEffectiveMode(config);
    const greeting = getGreetingText(effectiveMode);
    addMessage("assistant", greeting);
  } catch (error) {
    console.error("[Popup] Error initializing runtime:", error);
    elements.statusText.textContent = "Error initializing";
    elements.statusDot.className = "status-dot error";
    
    // Still enable input in offline mode
    elements.messageInput.disabled = false;
    elements.sendBtn.disabled = false;
    addMessage("assistant", "Error initializing. Please check the console for details.");
  }
}

// ============================================
// Event Listeners
// ============================================

// Message form
elements.messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = elements.messageInput.value.trim();
  if (text) {
    handleSendMessage(text);
  }
});

// Clear chat
elements.clearChatBtn.addEventListener("click", () => {
  handleClearChat();
});

// Settings
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

// Provider selection change
elements.providerSelect.addEventListener("change", () => {
  config.mode = elements.providerSelect.value as ProviderMode;
  updateProviderSettings();
});

// Initialize on load
console.log("[Popup] Setting up initialization...");
try {
  initialize().catch((error) => {
    console.error("[Popup] Initialize promise rejected:", error);
    const statusEl = document.getElementById("statusText");
    if (statusEl) statusEl.textContent = "Init failed - check console";
  });
} catch (error) {
  console.error("[Popup] Initialize threw:", error);
  const statusEl = document.getElementById("statusText");
  if (statusEl) statusEl.textContent = "Init error - check console";
}
