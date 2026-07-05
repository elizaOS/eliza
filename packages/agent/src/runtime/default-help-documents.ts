/**
 * Bundled help knowledge — the app's user-facing FAQ as retrievable documents,
 * one per topic, one Q&A fragment per question. Seeded by
 * `seedBundledDocuments` (default-documents.ts) so the agent can answer
 * "how do I…" questions about the app from day one; there is no separate Help
 * view — the chat IS the help surface.
 *
 * Copy rules: durable knowledge only. Answers describe what the user can do
 * in the app or ask the agent in chat — never "tap the button below" or other
 * screen-relative instructions that rot when the UI moves. Bump a document's
 * `version` whenever its entries change so stale fragments get pruned.
 */
import type { DefaultDocumentDefinition } from "./default-documents";

interface HelpEntry {
  question: string;
  answer: string;
}

export const HELP_KNOWLEDGE_TAG = "help";

function helpDocument(
  key: string,
  title: string,
  version: number,
  entries: readonly HelpEntry[],
): DefaultDocumentDefinition {
  const fragments = entries.map((entry) => ({
    text: `Q: ${entry.question}\nA: ${entry.answer}`,
  }));
  return {
    key,
    version,
    filename: `${key}.txt`,
    contentType: "text/plain",
    text: [`${title}`, "", ...fragments.map((f) => f.text)].join("\n\n"),
    fragments,
    metadata: { tags: [HELP_KNOWLEDGE_TAG], helpCategory: title },
  };
}

export const HELP_DOCUMENTS: readonly DefaultDocumentDefinition[] = [
  helpDocument("eliza-help-getting-started", "Eliza help: getting started", 1, [
    {
      question: "What is Eliza?",
      answer:
        "Eliza is your personal AI agent. It chats with you by text or voice, can run on your own device or in the cloud, and can do real work — answer questions, manage tasks, use connected apps, and control its own screens. You drive all of it through one chat that floats over every view.",
    },
    {
      question: "I just opened Eliza — what do I do first?",
      answer:
        'Take the interactive tutorial: type "start tutorial" in the chat (or open the Tutorial tile in the launcher). It walks you through the basics right in the conversation — sending messages, voice, navigating by asking — in about a minute, and you can stop it anytime by typing "stop tutorial".',
    },
    {
      question: "What is the glowing pill at the bottom of the screen?",
      answer:
        "That's the chat — the one place you talk to Eliza. It floats over every screen so it's always reachable. Tap it to open, type or talk, drag the handle up to expand it, or swipe down to shrink it back to the pill.",
    },
  ]),
  helpDocument(
    "eliza-help-chat-navigation",
    "Eliza help: chat and navigation",
    1,
    [
      {
        question: "How do I open and close the chat?",
        answer:
          "Tap the floating pill to open the chat. To expand it full-screen, drag the handle at the top upward (or tap it). To minimize, swipe down on the handle — it collapses back to the pill but stays one tap away.",
      },
      {
        question: "How do I switch screens or views?",
        answer:
          'Two ways: tap a tile on the launcher screen, or just ask the chat — type or say things like "open settings", "go home", or "show my tasks" and Eliza navigates there for you.',
      },
      {
        question: "Can I navigate just by talking to Eliza?",
        answer:
          'Yes. Eliza understands navigation requests in plain language. In the chat, type or speak "open settings", "take me home", "show the model settings", and it switches screens for you — no menus required.',
      },
      {
        question: "How do I get to Settings?",
        answer:
          'Tap the Settings tile in the launcher, or ask the chat to "open settings". Settings is where you choose your AI model, turn on voice, connect apps, and pick local vs cloud.',
      },
    ],
  ),
  helpDocument("eliza-help-ai-models", "Eliza help: AI models", 1, [
    {
      question: "How do I change the AI model?",
      answer:
        'Go to Settings → AI Model (or ask the chat to "open the model settings"). You can pick a cloud provider (like Anthropic or OpenAI with your key, or Eliza Cloud) or download a local model that runs entirely on your device.',
    },
    {
      question: "Can Eliza run AI on my own device, offline?",
      answer:
        "Yes — that's local inference. In Settings → AI Model you can download a local model that runs on-device with no cloud calls, so it works offline and keeps everything private. The recommended local model is eliza-1, but you can search and download many models.",
    },
    {
      question: "Which model should I use?",
      answer:
        "For a fully local, private setup, eliza-1 is the recommended on-device model. If you want maximum capability and don't mind using the cloud, connect a frontier provider (Anthropic or OpenAI) or log in to Eliza Cloud.",
    },
  ]),
  helpDocument("eliza-help-privacy-data", "Eliza help: privacy and data", 1, [
    {
      question: "Is my data private and stored locally?",
      answer:
        "Eliza is local-first. Your conversations and data live on your device by default, in local storage. If you choose a cloud model or log in to Eliza Cloud, only the requests needed for that service leave your device — you stay in control.",
    },
    {
      question:
        "What is the difference between local, cloud, and remote setups?",
      answer:
        "Local: the agent and models run on your device (most private, works offline). Cloud: a hosted agent runs in Eliza Cloud (best for mobile, nothing to manage). Local + Cloud: a local agent that uses cloud models and services when it needs more power. Remote: connect to an agent you already run elsewhere. You can switch in Settings → Runtime.",
    },
  ]),
  helpDocument("eliza-help-voice", "Eliza help: voice", 1, [
    {
      question: "How do I talk to Eliza by voice?",
      answer:
        'Open the chat and tap the microphone. Speak naturally — Eliza transcribes you, replies, and can speak its answer back. You can even navigate by voice ("open settings", "go home").',
    },
    {
      question: "How do I turn voice on or pick a different voice?",
      answer:
        "Open Settings and find the voice options to enable spoken replies and choose a voice. Voice works locally on-device or via the cloud depending on your setup.",
    },
    {
      question: "Voice isn't working — what should I check?",
      answer:
        "Make sure you granted microphone permission, your device isn't muted, and a voice model is ready (first use may download one). Try toggling voice off and on in Settings, then tap the mic again.",
    },
  ]),
  helpDocument("eliza-help-connectors", "Eliza help: connecting apps", 1, [
    {
      question: "What are connectors?",
      answer:
        "Connectors let Eliza work with your other apps and platforms — Discord, Telegram, Slack, X, WhatsApp, and more — so it can read and send messages there on your behalf. You add them in Settings.",
    },
    {
      question: "How do I connect Discord, Telegram, or Slack?",
      answer:
        "Open Settings, find Connectors, choose the platform, and follow the steps to paste a token or authorize it. Once connected, Eliza can chat on that platform alongside your local chat.",
    },
  ]),
  helpDocument("eliza-help-eliza-cloud", "Eliza help: Eliza Cloud", 1, [
    {
      question: "What is Eliza Cloud?",
      answer:
        "Eliza Cloud is the optional managed backend. It can host your agent, route AI requests, handle login and billing, and run server-side workloads — so you don't have to manage a model or keys yourself. It's optional: Eliza runs fully local without it.",
    },
    {
      question: "Do I need to log in to Eliza Cloud?",
      answer:
        "No. Eliza works fully on your device without any account. Logging in to Eliza Cloud is optional and unlocks hosted models, cross-device sync, and managed services if you want them.",
    },
    {
      question: "How do I log in to Eliza Cloud?",
      answer:
        "Open Settings → AI Model and choose to connect Eliza Cloud, then follow the sign-in. Once linked, you can use hosted models and services without managing your own keys.",
    },
  ]),
  helpDocument("eliza-help-capabilities", "Eliza help: what Eliza can do", 1, [
    {
      question: "What can Eliza actually do?",
      answer:
        "Beyond chatting, Eliza can manage tasks and reminders, search and remember things, use connected apps, browse, run skills, and open and control its own screens. What's available depends on the model and connectors you've set up.",
    },
    {
      question: "What are skills?",
      answer:
        "Skills are packages of know-how that teach Eliza how to do specific things — like using a particular app, following a workflow, or a specialized task. You can browse the skills it has in the Skills view and add more.",
    },
    {
      question: "What is the Launcher?",
      answer:
        "The Launcher is the home for every screen Eliza can show you — your tasks, documents, memories, settings, and specialized tools. Swipe right from the home dashboard to reach it, open any screen from there or by asking the chat, and Eliza can also open them for you.",
    },
  ]),
  helpDocument("eliza-help-troubleshooting", "Eliza help: troubleshooting", 1, [
    {
      question: "Eliza isn't responding to my messages.",
      answer:
        "Most often there's no AI model set up yet. Open Settings → AI Model and either add a provider key, log in to Eliza Cloud, or download a local model. If a model is set, give it a moment — the first reply after startup can take a few seconds.",
    },
    {
      question: "Eliza is slow to start up.",
      answer:
        "On first launch it may download a model in the background, which takes time once. After that, the app is usable the moment it opens — the agent's first-reply ability fades in a second or two behind a live screen.",
    },
    {
      question: "How do I reset or start fresh?",
      answer:
        "You can reset settings and data from Settings → Runtime (look for reset and advanced options). Be careful: resetting clears local data. If you only want a fresh conversation, start a new chat instead.",
    },
    {
      question: "How do I see the tutorial again?",
      answer:
        'Type "restart tutorial" in the chat any time, or open the Tutorial tile in the launcher. The tour runs right in the conversation and is always re-runnable — nothing is one-time-only.',
    },
  ]),
];
