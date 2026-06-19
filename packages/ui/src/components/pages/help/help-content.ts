/**
 * Eliza Help knowledge base. Plain-language answers to what a confused new user
 * actually asks, each with an optional deep-link into the app (a tab, or a
 * Settings section). Searched client-side over question + answer + keywords.
 *
 * Keep answers short (2-4 sentences), accurate to the product, and jargon-light.
 */

export interface HelpDeepLink {
  label: string;
  /** Navigate to this tab/view. */
  tab?: string;
  /** Open Settings to this section id (identity | ai-model | runtime | appearance). */
  settingsSection?: string;
  /** Launch the interactive tutorial. */
  startTutorial?: boolean;
}

export interface HelpEntry {
  id: string;
  category: HelpCategory;
  question: string;
  answer: string;
  keywords: string[];
  deepLink?: HelpDeepLink;
}

export type HelpCategory =
  | "Getting started"
  | "Chat & navigation"
  | "AI models"
  | "Privacy & data"
  | "Voice"
  | "Connecting apps"
  | "Eliza Cloud"
  | "What Eliza can do"
  | "Troubleshooting";

export const HELP_CATEGORIES: HelpCategory[] = [
  "Getting started",
  "Chat & navigation",
  "AI models",
  "Privacy & data",
  "Voice",
  "Connecting apps",
  "Eliza Cloud",
  "What Eliza can do",
  "Troubleshooting",
];

export const HELP_ENTRIES: HelpEntry[] = [
  // ── Getting started ───────────────────────────────────────────────────────
  {
    id: "what-is-eliza",
    category: "Getting started",
    question: "What is Eliza?",
    answer:
      "Eliza is your personal AI agent. It chats with you by text or voice, can run on your own device or in the cloud, and can do real work — answer questions, manage tasks, use connected apps, and control its own screens. You drive all of it through one chat that floats over every view.",
    keywords: ["what", "eliza", "about", "agent", "ai", "assistant", "intro"],
    deepLink: { label: "Take the 90-second tour", startTutorial: true },
  },
  {
    id: "first-thing",
    category: "Getting started",
    question: "I just opened Eliza — what do I do first?",
    answer:
      "Take the interactive tutorial (the first tile on your home screen). It walks you through the chat, switching screens, and Settings in about 90 seconds, checking each step as you go.",
    keywords: ["start", "first", "begin", "new", "tutorial", "onboarding"],
    deepLink: { label: "Start the tutorial", startTutorial: true },
  },
  {
    id: "the-chat-pill",
    category: "Getting started",
    question: "What is the glowing pill at the bottom?",
    answer:
      "That's your chat — the one place you talk to Eliza. It floats over every screen so it's always reachable. Tap it to open, type or talk, drag the handle up to expand it, or swipe down to shrink it back to the pill.",
    keywords: ["pill", "bubble", "bottom", "floating", "chat", "capsule"],
  },

  // ── Chat & navigation ─────────────────────────────────────────────────────
  {
    id: "open-chat",
    category: "Chat & navigation",
    question: "How do I open and close the chat?",
    answer:
      "Tap the floating pill to open the chat. To expand it full-screen, drag the handle at the top upward (or tap it). To minimize, swipe down on the handle — it collapses back to the pill but stays one tap away.",
    keywords: [
      "open",
      "close",
      "expand",
      "minimize",
      "maximize",
      "hide",
      "show",
      "chat",
      "collapse",
    ],
  },
  {
    id: "switch-views",
    category: "Chat & navigation",
    question: "How do I switch screens / views?",
    answer:
      "Two ways: tap a tile on the home screen, or just ask the chat — type or say things like “open settings”, “go home”, or “show my tasks” and Eliza navigates there for you.",
    keywords: [
      "switch",
      "change",
      "view",
      "screen",
      "navigate",
      "tab",
      "move",
      "go",
    ],
    deepLink: { label: "Open Views", tab: "views" },
  },
  {
    id: "navigate-by-talking",
    category: "Chat & navigation",
    question: "Can I really navigate just by talking to it?",
    answer:
      "Yes. Eliza understands navigation requests in plain language. In the chat, type or speak “open settings”, “take me home”, “show the model settings”, etc., and it switches screens for you — no menus required.",
    keywords: [
      "talk",
      "voice",
      "navigate",
      "command",
      "ask",
      "say",
      "natural language",
    ],
  },
  {
    id: "get-to-settings",
    category: "Chat & navigation",
    question: "How do I get to Settings?",
    answer:
      "Tap the Settings tile on the home screen, or ask the chat to “open settings”. Settings is where you choose your AI model, turn on voice, connect apps, and pick local vs cloud.",
    keywords: ["settings", "preferences", "options", "configure", "setup"],
    deepLink: { label: "Open Settings", tab: "settings" },
  },

  // ── AI models ─────────────────────────────────────────────────────────────
  {
    id: "change-model",
    category: "AI models",
    question: "How do I change the AI model?",
    answer:
      "Go to Settings → AI Model. You can pick a cloud provider (like Anthropic or OpenAI with your key, or Eliza Cloud) or download a local model that runs entirely on your device.",
    keywords: [
      "model",
      "change",
      "switch",
      "llm",
      "ai",
      "provider",
      "anthropic",
      "openai",
      "gpt",
      "claude",
    ],
    deepLink: {
      label: "Open AI Model settings",
      tab: "settings",
      settingsSection: "ai-model",
    },
  },
  {
    id: "local-inference",
    category: "AI models",
    question: "Can Eliza run AI on my own device (offline)?",
    answer:
      "Yes — that's local inference. In Settings → AI Model you can download a local model that runs on-device with no cloud calls, so it works offline and keeps everything private. The recommended local model is eliza-1, but you can search and download many models.",
    keywords: [
      "local",
      "offline",
      "on-device",
      "private",
      "download",
      "model",
      "inference",
      "eliza-1",
      "no internet",
    ],
    deepLink: {
      label: "Open AI Model settings",
      tab: "settings",
      settingsSection: "ai-model",
    },
  },
  {
    id: "recommended-model",
    category: "AI models",
    question: "Which model should I use?",
    answer:
      "For a fully local, private setup, eliza-1 is the recommended on-device model. If you want maximum capability and don't mind using the cloud, connect a frontier provider (Anthropic/OpenAI) or log in to Eliza Cloud.",
    keywords: [
      "recommended",
      "best",
      "which",
      "model",
      "eliza-1",
      "good",
      "default",
    ],
    deepLink: {
      label: "Open AI Model settings",
      tab: "settings",
      settingsSection: "ai-model",
    },
  },

  // ── Privacy & data ────────────────────────────────────────────────────────
  {
    id: "is-data-local",
    category: "Privacy & data",
    question: "Is my data private / stored locally?",
    answer:
      "Eliza is local-first. Your conversations and data live on your device by default, in local storage. If you choose a cloud model or log in to Eliza Cloud, only the requests needed for that service leave your device — you stay in control.",
    keywords: [
      "privacy",
      "private",
      "data",
      "local",
      "stored",
      "where",
      "secure",
      "cloud",
      "offline",
    ],
    deepLink: {
      label: "Open runtime settings",
      tab: "settings",
      settingsSection: "runtime",
    },
  },
  {
    id: "topologies",
    category: "Privacy & data",
    question: "What's the difference between local, cloud, and remote?",
    answer:
      "Local: the agent and models run on your device (most private, works offline). Cloud: a hosted agent runs in Eliza Cloud (best for mobile, nothing to manage). Local + Cloud: a local agent that uses cloud models/services when it needs more power. You can switch in Settings → Runtime.",
    keywords: [
      "local",
      "cloud",
      "remote",
      "topology",
      "difference",
      "mode",
      "hosted",
      "device",
    ],
    deepLink: {
      label: "Open runtime settings",
      tab: "settings",
      settingsSection: "runtime",
    },
  },

  // ── Voice ─────────────────────────────────────────────────────────────────
  {
    id: "talk-by-voice",
    category: "Voice",
    question: "How do I talk to Eliza by voice?",
    answer:
      "Open the chat and tap the microphone. Speak naturally — Eliza transcribes you, replies, and can speak its answer back. You can even navigate by voice (“open settings”, “go home”).",
    keywords: [
      "voice",
      "talk",
      "speak",
      "microphone",
      "mic",
      "say",
      "hands-free",
      "audio",
    ],
  },
  {
    id: "enable-voice",
    category: "Voice",
    question: "How do I turn voice on or pick a voice?",
    answer:
      "Open Settings and find the voice options to enable spoken replies and choose a voice. Voice works locally on-device or via the cloud depending on your setup.",
    keywords: [
      "voice",
      "enable",
      "turn on",
      "settings",
      "tts",
      "speak",
      "sound",
      "choose voice",
    ],
    deepLink: { label: "Open Settings", tab: "settings" },
  },
  {
    id: "voice-not-working",
    category: "Voice",
    question: "Voice isn't working — what do I check?",
    answer:
      "Make sure you granted microphone permission, your device isn't muted, and a voice model is ready (first use may download one). Try toggling voice off and on in Settings, then tap the mic again.",
    keywords: [
      "voice",
      "not working",
      "broken",
      "microphone",
      "permission",
      "mute",
      "no sound",
      "troubleshoot",
    ],
    deepLink: { label: "Open Settings", tab: "settings" },
  },

  // ── Connecting apps ───────────────────────────────────────────────────────
  {
    id: "what-are-connectors",
    category: "Connecting apps",
    question: "What are connectors?",
    answer:
      "Connectors let Eliza work with your other apps and platforms — Discord, Telegram, Slack, X, WhatsApp, and more — so it can read and send messages there on your behalf. You add them in Settings.",
    keywords: [
      "connector",
      "connect",
      "integration",
      "apps",
      "platform",
      "discord",
      "telegram",
      "slack",
    ],
    deepLink: { label: "Open Settings", tab: "settings" },
  },
  {
    id: "connect-discord",
    category: "Connecting apps",
    question: "How do I connect Discord / Telegram / Slack?",
    answer:
      "Open Settings, find Connectors, choose the platform, and follow the steps to paste a token or authorize it. Once connected, Eliza can chat on that platform alongside your local chat.",
    keywords: [
      "discord",
      "telegram",
      "slack",
      "whatsapp",
      "connect",
      "add",
      "token",
      "platform",
      "x",
      "twitter",
    ],
    deepLink: { label: "Open Settings", tab: "settings" },
  },

  // ── Eliza Cloud ───────────────────────────────────────────────────────────
  {
    id: "what-is-cloud",
    category: "Eliza Cloud",
    question: "What is Eliza Cloud?",
    answer:
      "Eliza Cloud is the optional managed backend. It can host your agent, route AI requests, handle login and billing, and run server-side workloads — so you don't have to manage a model or keys yourself. It's optional: Eliza runs fully local without it.",
    keywords: [
      "cloud",
      "eliza cloud",
      "hosted",
      "managed",
      "backend",
      "service",
      "what",
    ],
  },
  {
    id: "do-i-need-cloud",
    category: "Eliza Cloud",
    question: "Do I need to log in to Eliza Cloud?",
    answer:
      "No. Eliza works fully on your device without any account. Logging in to Eliza Cloud is optional and just unlocks hosted models, cross-device sync, and managed services if you want them.",
    keywords: [
      "cloud",
      "login",
      "account",
      "need",
      "required",
      "sign in",
      "optional",
    ],
    deepLink: {
      label: "Open AI Model / Cloud settings",
      tab: "settings",
      settingsSection: "ai-model",
    },
  },
  {
    id: "cloud-login",
    category: "Eliza Cloud",
    question: "How do I log in to Eliza Cloud?",
    answer:
      "Open Settings → AI Model (Cloud) and choose to connect Eliza Cloud, then follow the sign-in. Once linked, you can use hosted models and services without managing your own keys.",
    keywords: [
      "login",
      "log in",
      "sign in",
      "cloud",
      "connect",
      "account",
      "authenticate",
    ],
    deepLink: {
      label: "Open Cloud settings",
      tab: "settings",
      settingsSection: "ai-model",
    },
  },

  // ── What Eliza can do ─────────────────────────────────────────────────────
  {
    id: "what-can-it-do",
    category: "What Eliza can do",
    question: "What can Eliza actually do?",
    answer:
      "Beyond chatting, Eliza can manage tasks and reminders, search and remember things, use connected apps, browse, run skills, and even open and control its own screens. What's available depends on the model and connectors you've set up.",
    keywords: [
      "do",
      "capabilities",
      "features",
      "what",
      "can",
      "abilities",
      "tasks",
      "actions",
    ],
    deepLink: { label: "Browse Views", tab: "views" },
  },
  {
    id: "what-are-skills",
    category: "What Eliza can do",
    question: "What are skills?",
    answer:
      "Skills are packages of know-how that teach Eliza how to do specific things — like using a particular app, following a workflow, or a specialized task. You can browse the skills it has and add more.",
    keywords: [
      "skills",
      "abilities",
      "knowledge",
      "use_skill",
      "packages",
      "capabilities",
    ],
    deepLink: { label: "Open Skills", tab: "skills" },
  },
  {
    id: "views-and-apps",
    category: "What Eliza can do",
    question: "What are Views and Apps?",
    answer:
      "Views and Apps are the screens Eliza can show you — things like your tasks, documents, memories, settings, or specialized tools. You can open them from the home tiles or by asking the chat; Eliza can also open them for you.",
    keywords: [
      "views",
      "apps",
      "screens",
      "tools",
      "tiles",
      "surfaces",
      "what",
    ],
    deepLink: { label: "Open Views", tab: "views" },
  },

  // ── Troubleshooting ───────────────────────────────────────────────────────
  {
    id: "not-responding",
    category: "Troubleshooting",
    question: "Eliza isn't responding to my messages.",
    answer:
      "Most often there's no AI model set up yet. Open Settings → AI Model and either add a provider key, log in to Eliza Cloud, or download a local model. If a model is set, give it a moment — the first reply after startup can take a few seconds.",
    keywords: [
      "not responding",
      "no reply",
      "stuck",
      "broken",
      "silent",
      "no answer",
      "model",
      "provider",
    ],
    deepLink: {
      label: "Open AI Model settings",
      tab: "settings",
      settingsSection: "ai-model",
    },
  },
  {
    id: "slow-start",
    category: "Troubleshooting",
    question: "Eliza is slow to start up.",
    answer:
      "On first launch it may download a model in the background, which takes time once. After that, the app is usable the moment it opens — the agent's first-reply ability fades in a second or two behind a live screen.",
    keywords: [
      "slow",
      "startup",
      "loading",
      "boot",
      "wait",
      "warming up",
      "download",
      "first run",
    ],
  },
  {
    id: "reset",
    category: "Troubleshooting",
    question: "How do I reset or start fresh?",
    answer:
      "You can reset settings and data from Settings → Runtime (look for reset/advanced options). Be careful: resetting clears local data. If you only want a fresh conversation, start a new chat instead.",
    keywords: [
      "reset",
      "start over",
      "fresh",
      "clear",
      "wipe",
      "delete",
      "factory",
    ],
    deepLink: {
      label: "Open runtime settings",
      tab: "settings",
      settingsSection: "runtime",
    },
  },
  {
    id: "rerun-tutorial",
    category: "Troubleshooting",
    question: "How do I see the tutorial again?",
    answer:
      "Tap the Tutorial tile on your home screen any time to re-run the interactive tour. It's always available — nothing is one-time-only.",
    keywords: [
      "tutorial",
      "again",
      "replay",
      "re-run",
      "tour",
      "walkthrough",
      "help",
    ],
    deepLink: { label: "Start the tutorial", startTutorial: true },
  },
];
