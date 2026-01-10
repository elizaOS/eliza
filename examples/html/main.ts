/**
 * ELIZA Demo - Full elizaOS Integration
 * 
 * This demo shows the full elizaOS runtime running in the browser
 * with PGLite (in-memory PostgreSQL) and classic ELIZA pattern matching.
 */

import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  stringToUuid,
  type Character,
  type UUID,
  type Plugin,
  type IAgentRuntime,
  type GenerateTextParams,
  ModelType,
} from "@elizaos/core";
import { plugin as sqlPlugin } from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";

// ============================================================================
// Classic ELIZA Pattern Matching Engine
// ============================================================================

interface PatternRule {
  keyword: string;
  weight: number;
  rules: Array<{
    pattern: RegExp;
    responses: string[];
  }>;
}

const elizaPatterns: PatternRule[] = [
  {
    keyword: "sorry",
    weight: 1,
    rules: [{
      pattern: /.*/,
      responses: [
        "Please don't apologize.",
        "Apologies are not necessary.",
        "What feelings do you have when you apologize?",
        "I've told you that apologies are not required."
      ]
    }]
  },
  {
    keyword: "remember",
    weight: 5,
    rules: [
      {
        pattern: /do you remember (.*)/i,
        responses: [
          "Did you think I would forget $1?",
          "Why do you think I should recall $1 now?",
          "What about $1?"
        ]
      },
      {
        pattern: /i remember (.*)/i,
        responses: [
          "Do you often think of $1?",
          "Does thinking of $1 bring anything else to mind?",
          "What else do you remember?",
          "Why do you remember $1 just now?"
        ]
      }
    ]
  },
  {
    keyword: "dream",
    weight: 4,
    rules: [{
      pattern: /.*/,
      responses: [
        "What does that dream suggest to you?",
        "Do you dream often?",
        "What persons appear in your dreams?",
        "Do you believe that dreams have something to do with your problems?"
      ]
    }]
  },
  {
    keyword: "hello",
    weight: 0,
    rules: [{
      pattern: /.*/,
      responses: [
        "How do you do. Please state your problem.",
        "Hi. What seems to be your problem?",
        "Hello. Tell me what's on your mind."
      ]
    }]
  },
  {
    keyword: "computer",
    weight: 50,
    rules: [{
      pattern: /.*/,
      responses: [
        "Do computers worry you?",
        "Why do you mention computers?",
        "What do you think machines have to do with your problem?",
        "Don't you think computers can help people?"
      ]
    }]
  },
  {
    keyword: "feel",
    weight: 3,
    rules: [
      {
        pattern: /i (?:feel|felt) (.*)/i,
        responses: [
          "Tell me more about such feelings.",
          "Do you often feel $1?",
          "Do you enjoy feeling $1?",
          "Of what does feeling $1 remind you?"
        ]
      }
    ]
  },
  {
    keyword: "think",
    weight: 2,
    rules: [
      {
        pattern: /i (?:believe|think) (.*)/i,
        responses: [
          "Do you really think so?",
          "But you are not sure you $1.",
          "Do you really doubt you $1?"
        ]
      }
    ]
  },
  {
    keyword: "want",
    weight: 2,
    rules: [
      {
        pattern: /i (?:desire|want|need) (.*)/i,
        responses: [
          "What would it mean to you if you got $1?",
          "Why do you want $1?",
          "Suppose you got $1 soon?",
          "What if you never got $1?"
        ]
      }
    ]
  },
  {
    keyword: "my mother",
    weight: 6,
    rules: [{
      pattern: /.*/,
      responses: [
        "Tell me more about your mother.",
        "What was your relationship with your mother like?",
        "How do you feel about your mother?",
        "Does this have to do with your mother?"
      ]
    }]
  },
  {
    keyword: "my father",
    weight: 6,
    rules: [{
      pattern: /.*/,
      responses: [
        "Tell me more about your father.",
        "How did your father treat you?",
        "How do you feel about your father?",
        "Does your relationship with your father relate to your feelings today?"
      ]
    }]
  },
  {
    keyword: "am i",
    weight: 1,
    rules: [
      {
        pattern: /am i (.*)/i,
        responses: [
          "Do you believe you are $1?",
          "Would you want to be $1?",
          "Do you wish I would tell you you are $1?",
          "What would it mean if you were $1?"
        ]
      }
    ]
  },
  {
    keyword: "i am",
    weight: 1,
    rules: [
      {
        pattern: /i am (.*)/i,
        responses: [
          "Is it because you are $1 that you came to me?",
          "How long have you been $1?",
          "How do you feel about being $1?",
          "Do you enjoy being $1?"
        ]
      }
    ]
  },
  {
    keyword: "are you",
    weight: 1,
    rules: [
      {
        pattern: /are you (.*)/i,
        responses: [
          "Why are you interested in whether I am $1 or not?",
          "Would you prefer if I weren't $1?",
          "Perhaps I am $1 in your fantasies.",
          "Do you sometimes think I am $1?"
        ]
      }
    ]
  },
  {
    keyword: "you are",
    weight: 1,
    rules: [
      {
        pattern: /you are (.*)/i,
        responses: [
          "What makes you think I am $1?",
          "Does it please you to believe I am $1?",
          "Do you sometimes wish you were $1?",
          "Perhaps you would like to be $1."
        ]
      }
    ]
  },
  {
    keyword: "can't",
    weight: 2,
    rules: [
      {
        pattern: /i can'?t (.*)/i,
        responses: [
          "How do you know that you can't $1?",
          "Have you tried?",
          "Perhaps you could $1 now.",
          "Do you really want to be able to $1?"
        ]
      }
    ]
  },
  {
    keyword: "why",
    weight: 1,
    rules: [{
      pattern: /.*/,
      responses: [
        "Why do you ask?",
        "Does that question interest you?",
        "What is it you really want to know?",
        "Are such questions much on your mind?",
        "What answer would please you most?"
      ]
    }]
  },
  {
    keyword: "because",
    weight: 0,
    rules: [{
      pattern: /.*/,
      responses: [
        "Is that the real reason?",
        "Don't any other reasons come to mind?",
        "Does that reason seem to explain anything else?",
        "What other reasons might there be?"
      ]
    }]
  },
  {
    keyword: "yes",
    weight: 0,
    rules: [{
      pattern: /.*/,
      responses: [
        "You seem quite positive.",
        "You are sure.",
        "I see.",
        "I understand."
      ]
    }]
  },
  {
    keyword: "no",
    weight: 0,
    rules: [{
      pattern: /.*/,
      responses: [
        "Are you saying 'no' just to be negative?",
        "You are being a bit negative.",
        "Why not?",
        "Why 'no'?"
      ]
    }]
  },
  {
    keyword: "always",
    weight: 1,
    rules: [{
      pattern: /.*/,
      responses: [
        "Can you think of a specific example?",
        "When?",
        "What incident are you thinking of?",
        "Really, always?"
      ]
    }]
  },
  {
    keyword: "perhaps",
    weight: 0,
    rules: [{
      pattern: /.*/,
      responses: [
        "You don't seem quite certain.",
        "Why the uncertain tone?",
        "Can't you be more positive?",
        "You aren't sure?",
        "Don't you know?"
      ]
    }]
  }
];

const defaultResponses = [
  "Very interesting.",
  "I am not sure I understand you fully.",
  "What does that suggest to you?",
  "Please continue.",
  "Go on.",
  "Do you feel strongly about discussing such things?",
  "Tell me more.",
  "That is quite interesting.",
  "Can you elaborate on that?",
  "Why do you say that?",
  "I see.",
  "What does that mean to you?",
  "How does that make you feel?",
  "Let's explore that further.",
  "Interesting. Please go on."
];

const responseHistory: string[] = [];
const MAX_HISTORY = 10;

function getRandomResponse(responses: string[]): string {
  const available = responses.filter(r => !responseHistory.includes(r));
  const pool = available.length > 0 ? available : responses;
  const response = pool[Math.floor(Math.random() * pool.length)];
  responseHistory.push(response);
  if (responseHistory.length > MAX_HISTORY) responseHistory.shift();
  return response;
}

function reflect(text: string): string {
  const reflections: Record<string, string> = {
    "am": "are", "was": "were", "i": "you", "i'd": "you would",
    "i've": "you have", "i'll": "you will", "my": "your",
    "are": "am", "you've": "I have", "you'll": "I will",
    "your": "my", "yours": "mine", "you": "me", "me": "you",
    "myself": "yourself", "yourself": "myself", "i'm": "you are"
  };
  
  const words = text.toLowerCase().split(/\s+/);
  return words.map(word => reflections[word] || word).join(" ");
}

function generateElizaResponse(input: string): string {
  const normalized = input.toLowerCase().trim();
  if (!normalized) return "I didn't catch that. Could you please repeat?";
  
  const matches: Array<{ pattern: PatternRule; rule: PatternRule["rules"][0] }> = [];
  
  for (const pattern of elizaPatterns) {
    if (normalized.includes(pattern.keyword)) {
      for (const rule of pattern.rules) {
        if (rule.pattern.test(normalized)) {
          matches.push({ pattern, rule });
        }
      }
    }
  }
  
  if (matches.length > 0) {
    matches.sort((a, b) => b.pattern.weight - a.pattern.weight);
    const best = matches[0];
    let response = getRandomResponse(best.rule.responses);
    
    const match = normalized.match(best.rule.pattern);
    if (match) {
      for (let i = 1; i < match.length; i++) {
        const captured = match[i] ? reflect(match[i]) : "";
        response = response.replace(`$${i}`, captured);
      }
    }
    
    response = response.replace(/\$\d+/g, "that");
    return response;
  }
  
  return getRandomResponse(defaultResponses);
}

// ============================================================================
// ELIZA Classic Plugin
// ============================================================================

async function handleElizaText(
  _runtime: IAgentRuntime,
  params: GenerateTextParams
): Promise<string> {
  const prompt = params.prompt || "";
  let userMessage = prompt;
  
  const userMatch = prompt.match(/User:\s*([^\n]+?)(?:\n|$)/i);
  if (userMatch) {
    userMessage = userMatch[1].trim();
  } else {
    const lines = prompt.split("\n").filter(l => l.trim());
    userMessage = lines[lines.length - 1] || prompt;
  }
  
  userMessage = userMessage.replace(/^(You|Eliza|Assistant|Agent):\s*/i, "").trim();
  return generateElizaResponse(userMessage);
}

async function handleEmbedding(
  _runtime: IAgentRuntime,
  params: { text: string } | string | null
): Promise<number[]> {
  const text = typeof params === "string" ? params : params?.text || "";
  const dimensions = 384;
  const embedding = new Array(dimensions).fill(0);
  
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i);
    embedding[i % dimensions] += charCode / 1000;
  }
  
  const magnitude = Math.sqrt(embedding.reduce((sum, val) => sum + val * val, 0));
  if (magnitude > 0) {
    for (let i = 0; i < dimensions; i++) {
      embedding[i] /= magnitude;
    }
  }
  
  return embedding;
}

const elizaClassicPlugin: Plugin = {
  name: "eliza-classic",
  description: "Classic ELIZA pattern matching (no LLM required)",
  models: {
    [ModelType.TEXT_SMALL]: handleElizaText,
    [ModelType.TEXT_LARGE]: handleElizaText,
    [ModelType.TEXT_EMBEDDING]: handleEmbedding,
  },
};

// ============================================================================
// Demo Application
// ============================================================================

interface DemoState {
  runtime: AgentRuntime | null;
  userId: UUID;
  roomId: UUID;
  worldId: UUID;
  isInitialized: boolean;
  isProcessing: boolean;
}

const state: DemoState = {
  runtime: null,
  userId: uuidv4() as UUID,
  roomId: stringToUuid("eliza-chat-room"),
  worldId: stringToUuid("eliza-chat-world"),
  isInitialized: false,
  isProcessing: false,
};

const character: Character = {
  name: "Eliza",
  bio: "I am ELIZA, a Rogerian psychotherapist simulation created at MIT in 1966. I use pattern matching and substitution to simulate conversation.",
  system: "You are ELIZA, a classic chatbot simulating a Rogerian psychotherapist. Respond with questions that encourage the user to reflect on their feelings.",
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

async function sendMessage(): Promise<void> {
  const elements = getElements();
  const text = elements.userInput.value.trim();
  
  if (!text || state.isProcessing || !state.runtime) return;
  
  state.isProcessing = true;
  elements.sendBtn.disabled = true;
  elements.userInput.disabled = true;
  
  addMessage(text, true);
  elements.userInput.value = "";
  
  showTyping();
  
  try {
    // Create message memory
    const message = createMessageMemory({
      id: uuidv4() as UUID,
      entityId: state.userId,
      roomId: state.roomId,
      content: { text },
    });
    
    // Use the runtime's message service
    let response = "";
    
    if (state.runtime.messageService) {
      await state.runtime.messageService.handleMessage(
        state.runtime,
        message,
        async (content) => {
          if (content?.text) {
            response += content.text;
          }
          return [];
        }
      );
    } else {
      // Fallback to direct ELIZA response
      response = generateElizaResponse(text);
    }
    
    // Simulate thinking delay
    await new Promise(resolve => setTimeout(resolve, 300 + Math.random() * 700));
    
    hideTyping();
    
    if (response) {
      addMessage(response);
    } else {
      addMessage(generateElizaResponse(text));
    }
  } catch (error) {
    console.error("Error processing message:", error);
    hideTyping();
    // Fall back to direct ELIZA response on error
    addMessage(generateElizaResponse(text));
  }
  
  state.isProcessing = false;
  elements.sendBtn.disabled = false;
  elements.userInput.disabled = false;
  elements.userInput.focus();
}

async function initializeRuntime(): Promise<void> {
  const elements = getElements();
  
  updateStatus("Initializing PGLite...", true);
  
  try {
    // Create runtime with our plugins
    const runtime = new AgentRuntime({
      character,
      plugins: [sqlPlugin, elizaClassicPlugin],
    });
    
    await runtime.initialize();
    state.runtime = runtime;
    
    updateStatus("Setting up connection...", true);
    
    // Setup connection
    await runtime.ensureConnection({
      entityId: state.userId,
      roomId: state.roomId,
      worldId: state.worldId,
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
        elizaOS Runtime Initialized<br>
        Database: PGLite (in-memory)<br>
        Model: ELIZA Pattern Matching<br>
        Agent: ${character.name}<br>
        ═══════════════════════════════════════
      </span>
    `;
    
    // Enable input
    elements.userInput.disabled = false;
    elements.sendBtn.disabled = false;
    elements.userInput.focus();
    
    // Welcome message
    await new Promise(resolve => setTimeout(resolve, 800));
    showTyping();
    await new Promise(resolve => setTimeout(resolve, 1200));
    hideTyping();
    addMessage("Hello. I am ELIZA, running on elizaOS with PGLite. How are you feeling today?");
    
  } catch (error) {
    console.error("Failed to initialize runtime:", error);
    updateStatus("Initialization failed - using fallback mode");
    
    elements.initMessage.innerHTML = `
      <span class="text" style="color: #ff6666;">
        ⚠ Runtime initialization failed<br>
        Running in standalone ELIZA mode<br>
        (Pattern matching still works!)
      </span>
    `;
    
    // Still enable input for standalone mode
    elements.userInput.disabled = false;
    elements.sendBtn.disabled = false;
    elements.userInput.focus();
    
    await new Promise(resolve => setTimeout(resolve, 500));
    addMessage("Hello. I am ELIZA. The full runtime couldn't initialize, but I can still talk with you. How are you feeling today?");
  }
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  const elements = getElements();
  
  elements.sendBtn.addEventListener("click", sendMessage);
  elements.userInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  
  initializeRuntime();
});

// Export for module usage
export { initializeRuntime, sendMessage, generateElizaResponse };

