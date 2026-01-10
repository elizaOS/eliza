/**
 * elizaOS 2.0 Browser Demo
 *
 * This demonstrates the full elizaOS runtime running in the browser with:
 * - PGLite (in-memory PostgreSQL via WebAssembly)
 * - Classic ELIZA pattern matching plugin
 * - Bootstrap plugin for core functionality
 *
 * Mirrors the structure of examples/chat/typescript/chat.ts
 */

import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  stringToUuid,
  bootstrapPlugin,
  type Character,
  type UUID,
} from "@elizaos/core";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import { elizaPlugin } from "./eliza-plugin";

// Character definition (same as chat.ts)
const character: Character = {
  name: "Eliza",
  bio: "I am ELIZA, a Rogerian psychotherapist simulation created at MIT in 1966. I use pattern matching to help you explore your thoughts and feelings.",
  system:
    "You are ELIZA, a classic chatbot simulating a Rogerian psychotherapist. Use reflective listening techniques to help users explore their feelings.",
};

// Connection IDs
const userId = uuidv4() as UUID;
const roomId = stringToUuid("eliza-chat-room");
const worldId = stringToUuid("eliza-chat-world");

// Runtime instance
let runtime: AgentRuntime | null = null;

// UI State
interface UIState {
  isProcessing: boolean;
  isInitialized: boolean;
}

const state: UIState = {
  isProcessing: false,
  isInitialized: false,
};

// DOM Elements
function getElements() {
  return {
    chat: document.getElementById("chat") as HTMLDivElement,
    userInput: document.getElementById("user-input") as HTMLInputElement,
    sendBtn: document.getElementById("send-btn") as HTMLButtonElement,
    typing: document.getElementById("typing") as HTMLDivElement,
    dbStatus: document.getElementById("db-status") as HTMLDivElement,
    dbStatusText: document.getElementById("db-status-text") as HTMLSpanElement,
    initMessage: document.getElementById("init-message") as HTMLDivElement,
    activityLed: document.getElementById("activity-led") as HTMLDivElement,
  };
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function addMessage(text: string, isUser = false): void {
  const elements = getElements();
  const messageDiv = document.createElement("div");
  messageDiv.className = `message ${isUser ? "user" : "eliza"}`;
  messageDiv.innerHTML = `
    <span class="label">${isUser ? "YOU" : "ELIZA"}:</span>
    <span class="text">${escapeHtml(text)}</span>
  `;
  elements.chat.appendChild(messageDiv);
  elements.chat.scrollTop = elements.chat.scrollHeight;
}

function showTyping(): void {
  const elements = getElements();
  elements.typing.classList.add("visible");
  elements.activityLed.style.animation = "blink 0.3s infinite";
}

function hideTyping(): void {
  const elements = getElements();
  elements.typing.classList.remove("visible");
  elements.activityLed.style.animation = "pulse 1s infinite";
}

function updateStatus(text: string, isLoading = false): void {
  const elements = getElements();
  elements.dbStatusText.textContent = text;
  if (isLoading) {
    elements.dbStatus.classList.add("loading");
  } else {
    elements.dbStatus.classList.remove("loading");
  }
}

function setInputEnabled(enabled: boolean): void {
  const elements = getElements();
  elements.userInput.disabled = !enabled;
  elements.sendBtn.disabled = !enabled;
  if (enabled) {
    elements.userInput.focus();
  }
}

/**
 * Send a message and get a response from ELIZA
 * This mirrors the chat.ts pattern exactly
 */
async function sendMessage(): Promise<void> {
  const elements = getElements();
  const text = elements.userInput.value.trim();

  if (!text || state.isProcessing || !runtime) return;

  state.isProcessing = true;
  setInputEnabled(false);

  // Display user message
  addMessage(text, true);
  elements.userInput.value = "";

  showTyping();

  try {
    // Create message memory (exactly like chat.ts)
    const message = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: userId,
      roomId,
      content: { text },
    });

    // Use the runtime's message service (exactly like chat.ts)
    let response = "";

    await runtime.messageService!.handleMessage(
      runtime,
      message,
      async (content) => {
        if (content?.text) {
          response += content.text;
        }
        return [];
      }
    );

    hideTyping();

    if (response) {
      addMessage(response);
    }
  } catch (error) {
    console.error("Error processing message:", error);
    hideTyping();
    addMessage("I'm having trouble processing that. Please try again.");
  }

  state.isProcessing = false;
  setInputEnabled(true);
}

/**
 * Initialize the elizaOS runtime
 * This mirrors the chat.ts initialization exactly
 */
async function initializeRuntime(): Promise<void> {
  const elements = getElements();

  console.log("🚀 Starting Eliza (Browser Runtime)...\n");
  updateStatus("Initializing PGLite...", true);

  try {
    // Create runtime with plugins (exactly like chat.ts)
    // Note: We use elizaPlugin instead of openaiPlugin
    runtime = new AgentRuntime({
      character,
      plugins: [sqlPlugin, bootstrapPlugin, elizaPlugin],
    });

    updateStatus("Initializing AgentRuntime...", true);
    await runtime.initialize();

    updateStatus("Setting up connection...", true);

    // Setup connection (exactly like chat.ts)
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "browser",
      channelId: "chat",
      serverId: "browser-server",
      type: ChannelType.DM,
    } as Parameters<typeof runtime.ensureConnection>[0]);

    state.isInitialized = true;
    updateStatus("System Ready");

    // Update init message
    elements.initMessage.innerHTML = `
      <span class="text">
        ═══════════════════════════════════════<br>
        elizaOS Runtime v2.0 Initialized<br>
        Database: PGLite (in-memory PostgreSQL)<br>
        Model: ELIZA Pattern Matching<br>
        Agent: ${character.name}<br>
        ═══════════════════════════════════════
      </span>
    `;

    // Enable input
    setInputEnabled(true);

    console.log("💬 Chat with Eliza (browser runtime)\n");

    // Welcome message
    await new Promise((resolve) => setTimeout(resolve, 800));
    showTyping();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    hideTyping();
    addMessage(
      "Hello. I am ELIZA, running on elizaOS 2.0 with PGLite. How are you feeling today?"
    );
  } catch (error) {
    console.error("Failed to initialize runtime:", error);
    updateStatus("Initialization failed");

    elements.initMessage.innerHTML = `
      <span class="text" style="color: #ff6666;">
        ⚠ Runtime initialization failed<br>
        Error: ${error instanceof Error ? error.message : String(error)}<br>
        Check the console for details.
      </span>
    `;
  }
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  const elements = getElements();

  // Event listeners
  elements.sendBtn.addEventListener("click", sendMessage);
  elements.userInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Start initialization
  initializeRuntime();
});

// Export for debugging
(window as Window & { elizaRuntime?: AgentRuntime }).elizaRuntime = runtime!;

