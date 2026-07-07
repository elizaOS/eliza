/**
 * What each builtin view's pixels must show to count as correctly rendered.
 *
 * Seeded from the real OCR of the committed all-views capture, so every label
 * here is one the packaged engine actually reads off a healthy render. Labels are
 * chosen for OCR stability — short, high-contrast chrome text ("Ask Eliza",
 * "Settings", section headers) rather than long body copy that garbles — and kept
 * deliberately loose (`requireAny` for time-of-day/empty-vs-populated states) so a
 * legitimate state change never trips the gate. Absence of an entry means the view
 * is only checked for the universal defects (blank pixels, developer-string leak,
 * placeholder text); presence lets a matched render earn a positive `verified`.
 *
 * Keyed by the capture slug (filename without extension). Third-party `plugin-*`
 * views are intentionally absent — they own their content and are checked only for
 * the universal defects.
 */
import type { OcrExpectation } from "./ocr-content-rules";

export const VIEW_EXPECTATIONS: Record<string, OcrExpectation> = {
  "builtin-chat": {
    // The composer placeholder is "Ask <agentName>" (Eliza in prod, the test
    // agent's name under smoke), and landscape legitimately compacts to just the
    // composer — so the agent-agnostic "Ask " prefix is the stable floor. A truly
    // blank chat is still caught by the blank-pixel rule, not this expectation.
    requireAny: [
      "Ask ",
      "Good evening",
      "Good morning",
      "Good afternoon",
      "what's up",
      "Welcome",
      "Today",
      "Weather",
    ],
  },
  "builtin-settings": {
    requireAll: ["Settings"],
    requireAny: ["Models & Providers", "Voice", "Appearance", "Basics"],
  },
  "builtin-help": {
    requireAny: [
      "What is Eliza",
      "what do I do first",
      "glowing pill",
      "switch screens",
    ],
  },
  "builtin-browser": {
    requireAny: [
      "Enter a URL",
      "Open a website",
      "Summarize a page",
      "Search the web",
    ],
  },
  "builtin-automations": {
    requireAll: ["Automations"],
    requireAny: [
      "Nothing scheduled yet",
      "New",
      "Tasks",
      "Workflows",
      "Active",
    ],
  },
  "builtin-documents": {
    requireAny: ["Add Knowledge", "Search knowledge", "Knowledge"],
  },
  "builtin-files": {
    requireAny: ["No files yet", "Documents", "Images", "Search files"],
  },
  "builtin-relationships": {
    requireAny: [
      "Relationships",
      "No relationships yet",
      "Search people",
      "Connect your platforms",
    ],
  },
  "builtin-skills": {
    requireAny: [
      "Skills",
      "Browse Marketplace",
      "No Skills Installed",
      "Search skills",
    ],
  },
  "builtin-memories": {
    requireAny: ["No memories yet", "Facts", "Browse"],
  },
  "builtin-stream": {
    requireAny: ["Stream Ready", "GO LIVE", "Go Live", "OFFLINE"],
  },
  "builtin-database": {
    requireAny: [
      "Select a table",
      "Open SQL editor",
      "SQL Editor",
      "Filter tables",
      "Tables",
    ],
  },
  "builtin-logs": {
    requireAny: [
      "All levels",
      "Alllevels",
      "Search logs",
      "searchlogs",
      "All tags",
      "Alltags",
    ],
  },
  "builtin-inventory": {
    requireAny: ["Wallet", "USDC", "Tokens", "Perps"],
  },
  "builtin-plugins": {
    requireAny: ["Plugin Catalog", "Search plugins", "Providers"],
  },
  "builtin-fine-tuning": {
    requireAll: ["Fine-Tuning"],
    requireAny: ["Status", "Trajectories", "RUNTIME", "JOBS"],
  },
  "builtin-skills-marketplace": {
    requireAny: ["Marketplace", "Install", "Search skills"],
  },
  // The launcher grid is its own content; `builtin-views` renders the same grid.
  "builtin-apps": {
    requireAny: [
      "My Apps",
      "No apps installed",
      "Create new app",
      "Install, create",
    ],
  },
  "builtin-views": {
    requireAny: ["Messages", "Settings", "Wallet", "Automations", "Knowledge"],
  },
  "builtin-character": {
    requireAny: ["Personality", "Relationships", "Knowledge", "Skills"],
  },
  "builtin-character-select": {
    requireAny: [
      "About Me",
      "Style Rules",
      "Chat Examples",
      "Post Examples",
      "System prompt",
      "You are",
      "Youare",
    ],
  },
  "builtin-runtime": {
    requireAny: ["Plugins", "Actions", "Providers"],
  },
  "builtin-tasks": {
    requireAll: ["Tasks"],
    requireAny: [
      "Tasks",
      "No coding tasks yet",
      "coding agent",
      "Projects unavailable",
    ],
  },
  "builtin-trajectories": {
    requireAny: ["No trajectories yet", "trajector"],
  },
  "builtin-transcripts": {
    requireAny: [
      "Live meeting",
      "Paste a Meet",
      "Teams",
      "Zoom link",
      "Join meeting",
      "No transcripts yet",
      "transcri",
      "recording",
    ],
  },
  "builtin-desktop": {
    requireAny: ["Desktop workspace", "Electrobun desktop runtime"],
  },
};

// Native/permission-gated views (camera, contacts, phone, rolodex, messages) are
// intentionally left unexpectationed: their capture renders the launcher-grid
// fallback rather than distinct content, so any expectation would either rubber-
// stamp the fallback or false-fail. They stay `needs-eyeball` — correctly flagged
// for a human to decide whether the native surface should render something.
