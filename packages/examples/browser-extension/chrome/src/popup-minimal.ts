/**
 * Minimal Popup Script - Uses only ELIZA Classic (no heavy AI dependencies)
 */

console.log("[Popup] Script loading...");

// Simple ELIZA Classic implementation (no external deps)
const elizaKeywords = [
  { pattern: /\bmother\b/i, response: "Tell me more about your family." },
  { pattern: /\bfather\b/i, response: "How does that make you feel about your father?" },
  { pattern: /\bfeel\b/i, response: "Do you often feel this way?" },
  { pattern: /\bthink\b/i, response: "Why do you think that?" },
  { pattern: /\bwant\b/i, response: "What would it mean if you got that?" },
  { pattern: /\bsad\b/i, response: "I'm sorry to hear you're feeling sad. Can you tell me more?" },
  { pattern: /\bhappy\b/i, response: "That's wonderful! What's making you happy?" },
  { pattern: /\byes\b/i, response: "You seem certain. Why is that?" },
  { pattern: /\bno\b/i, response: "Why not?" },
  { pattern: /\bwhy\b/i, response: "That's a good question. What do you think?" },
  { pattern: /\bhow\b/i, response: "What approach would you suggest?" },
  { pattern: /\bwhat\b/i, response: "Let me think about that. What does it mean to you?" },
  { pattern: /\bcan\b/i, response: "What makes you ask about that?" },
  { pattern: /\byou\b/i, response: "We were talking about you, not me." },
  { pattern: /\bI am\b/i, response: "How long have you been like that?" },
  { pattern: /\bI\b/i, response: "Tell me more about yourself." },
  { pattern: /.*/, response: "Please go on." },
];

function getElizaResponse(input: string, pageContext?: string): string {
  const lowerInput = input.toLowerCase();
  
  // Check if asking about page content
  if (pageContext && (lowerInput.includes("page") || lowerInput.includes("this") || lowerInput.includes("article") || lowerInput.includes("website"))) {
    const preview = pageContext.substring(0, 500);
    return `Based on this page, I can see: "${preview}..." What would you like to know about it?`;
  }
  
  for (const keyword of elizaKeywords) {
    if (keyword.pattern.test(input)) {
      return keyword.response;
    }
  }
  return "Interesting. Please continue.";
}

// DOM Elements
const statusText = document.getElementById("statusText") as HTMLSpanElement;
const statusDot = document.getElementById("statusDot") as HTMLDivElement;
const pageTitle = document.getElementById("pageTitle") as HTMLDivElement;
const pageUrl = document.getElementById("pageUrl") as HTMLDivElement;
const messagesDiv = document.getElementById("messages") as HTMLDivElement;
const messageForm = document.getElementById("messageForm") as HTMLFormElement;
const messageInput = document.getElementById("messageInput") as HTMLInputElement;
const sendBtn = document.getElementById("sendBtn") as HTMLButtonElement;
const clearChatBtn = document.getElementById("clearChatBtn") as HTMLButtonElement;

// State
let pageContent: string | null = null;
let pageInfo: { title: string; url: string } | null = null;

console.log("[Popup] Elements loaded, setting up...");

// Update UI status
function updateStatus(ready: boolean) {
  statusText.textContent = ready ? "ELIZA Classic" : "Initializing...";
  statusDot.className = ready ? "status-dot active" : "status-dot";
}

// Update page info display
function updatePageInfo(title: string | null, url: string | null) {
  if (title && url) {
    pageTitle.textContent = title;
    pageUrl.textContent = url;
    pageUrl.title = url;
  } else {
    pageTitle.textContent = "No page loaded";
    pageUrl.textContent = "";
  }
}

// Add message to chat
function addMessage(role: "user" | "assistant", content: string) {
  const msgDiv = document.createElement("div");
  msgDiv.className = `message ${role}`;
  msgDiv.textContent = content;
  messagesDiv.appendChild(msgDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// Fetch page content from background
async function fetchPageContent(): Promise<void> {
  console.log("[Popup] Fetching page content...");
  
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
      
      // Background returns { type: "PAGE_CONTENT_RESPONSE", content: { title, url, content, extractedAt } }
      if (response?.content) {
        pageContent = response.content.content || null;  // PageContent.content is the text
        pageInfo = {
          title: response.content.title || "Unknown",
          url: response.content.url || "",
        };
        updatePageInfo(pageInfo.title, pageInfo.url);
        console.log("[Popup] Page content loaded:", pageContent?.substring(0, 100));
      } else {
        console.log("[Popup] No page content in response:", response);
        updatePageInfo(null, null);
      }
      resolve();
    });
  });
}

// Handle sending message
function handleSend() {
  const text = messageInput.value.trim();
  if (!text) return;
  
  messageInput.value = "";
  addMessage("user", text);
  
  // Get ELIZA response
  const response = getElizaResponse(text, pageContent || undefined);
  
  // Simulate typing delay
  setTimeout(() => {
    addMessage("assistant", response);
  }, 300 + Math.random() * 500);
}

// Event listeners
messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  handleSend();
});

clearChatBtn.addEventListener("click", () => {
  messagesDiv.innerHTML = "";
  addMessage("assistant", "Chat cleared. How can I help you?");
});

// Initialize
async function init() {
  console.log("[Popup] Initializing...");
  
  try {
    await fetchPageContent();
  } catch (e) {
    console.error("[Popup] Error fetching page:", e);
  }
  
  // Enable inputs
  messageInput.disabled = false;
  sendBtn.disabled = false;
  messageInput.focus();
  
  // Update status
  updateStatus(true);
  
  // Add greeting
  addMessage("assistant", "Hello! I'm ELIZA. I can chat with you about this webpage or anything else. What's on your mind?");
  
  console.log("[Popup] Ready!");
}

init().catch((e) => {
  console.error("[Popup] Init failed:", e);
  statusText.textContent = "Error: " + (e as Error).message;
});

// Export empty object to make this a proper module (isolates global declarations)
export {};
