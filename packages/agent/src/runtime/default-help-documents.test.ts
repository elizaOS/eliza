/**
 * Unit coverage for the bundled help-FAQ catalog: tag, topic order, unique
 * keys, per-entry Q&A fragments, and the title-plus-spacer text join that
 * `helpDocument` publishes. Drives the real module; no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  HELP_DOCUMENTS,
  HELP_KNOWLEDGE_TAG,
} from "./default-help-documents.ts";

interface HelpEntry {
  question: string;
  answer: string;
}

interface ExpectedTopic {
  key: string;
  title: string;
  version: number;
  entries: readonly HelpEntry[];
}

const EXPECTED_TOPICS: readonly ExpectedTopic[] = [
  {
    key: "eliza-help-getting-started",
    title: "Eliza help: getting started",
    version: 2,
    entries: [
      {
        question: "What is Eliza?",
        answer:
          "Eliza is your personal AI agent. It chats with you by text or voice, can run on your own device or in the cloud, and can do real work — answer questions, manage tasks, use connected apps, and control its own screens. You drive all of it through one chat that floats over every view.",
      },
      {
        question: "I just opened Eliza — what do I do first?",
        answer:
          'Take the interactive tutorial: type "start tutorial" in the chat. It walks you through the basics right in the conversation — sending messages, voice, navigating by asking — in about a minute, and you can stop it anytime by typing "stop tutorial".',
      },
      {
        question: "What is the glowing pill at the bottom of the screen?",
        answer:
          "That's the chat — the one place you talk to Eliza. It floats over every screen so it's always reachable. Tap it to open, type or talk, drag the handle up to expand it, or swipe down to shrink it back to the pill.",
      },
    ],
  },
  {
    key: "eliza-help-chat-navigation",
    title: "Eliza help: chat and navigation",
    version: 1,
    entries: [
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
  },
  {
    key: "eliza-help-ai-models",
    title: "Eliza help: AI models",
    version: 1,
    entries: [
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
    ],
  },
  {
    key: "eliza-help-privacy-data",
    title: "Eliza help: privacy and data",
    version: 1,
    entries: [
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
    ],
  },
  {
    key: "eliza-help-voice",
    title: "Eliza help: voice",
    version: 1,
    entries: [
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
    ],
  },
  {
    key: "eliza-help-connectors",
    title: "Eliza help: connecting apps",
    version: 1,
    entries: [
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
    ],
  },
  {
    key: "eliza-help-eliza-cloud",
    title: "Eliza help: Eliza Cloud",
    version: 1,
    entries: [
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
    ],
  },
  {
    key: "eliza-help-capabilities",
    title: "Eliza help: what Eliza can do",
    version: 1,
    entries: [
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
    ],
  },
  {
    key: "eliza-help-troubleshooting",
    title: "Eliza help: troubleshooting",
    version: 2,
    entries: [
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
          'Type "restart tutorial" in the chat any time. The tour runs right in the conversation and is always re-runnable — nothing is one-time-only.',
      },
    ],
  },
];

function fragmentText(entry: HelpEntry): string {
  return `Q: ${entry.question}\nA: ${entry.answer}`;
}

describe("HELP_KNOWLEDGE_TAG", () => {
  it("is the stable retrieval tag stamped on every help document", () => {
    expect(HELP_KNOWLEDGE_TAG).toBe("help");
  });
});

describe("HELP_DOCUMENTS", () => {
  it("is a non-empty catalog (empty-queue analog: the bundled set is never vacant)", () => {
    expect(HELP_DOCUMENTS.length).toBeGreaterThan(0);
    expect(HELP_DOCUMENTS).toHaveLength(EXPECTED_TOPICS.length);
    expect(HELP_DOCUMENTS).toHaveLength(9);
  });

  it("publishes topics in catalog order with unique keys (no ties)", () => {
    const keys = HELP_DOCUMENTS.map((doc) => doc.key);
    expect(keys).toEqual(EXPECTED_TOPICS.map((topic) => topic.key));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("does not publish a single-entry or empty topic; smallest topics have two fragments", () => {
    const fragmentCounts = HELP_DOCUMENTS.map((doc) => doc.fragments.length);
    expect(Math.min(...fragmentCounts)).toBe(2);
    expect(
      HELP_DOCUMENTS.filter((doc) => doc.fragments.length === 2).map(
        (doc) => doc.key,
      ),
    ).toEqual(["eliza-help-privacy-data", "eliza-help-connectors"]);
  });

  it("names each file from its key and serves text/plain", () => {
    for (const doc of HELP_DOCUMENTS) {
      expect(doc.filename).toBe(`${doc.key}.txt`);
      expect(doc.contentType).toBe("text/plain");
    }
  });

  it("tags every document as help and stores the topic title as helpCategory", () => {
    for (const [index, doc] of HELP_DOCUMENTS.entries()) {
      const expected = EXPECTED_TOPICS[index];
      expect(doc.metadata).toEqual({
        tags: [HELP_KNOWLEDGE_TAG],
        helpCategory: expected.title,
      });
      expect(doc.version).toBe(expected.version);
    }
  });

  it("keeps getting-started and troubleshooting at version 2 and every other topic at 1", () => {
    const versions = Object.fromEntries(
      HELP_DOCUMENTS.map((doc) => [doc.key, doc.version]),
    );
    expect(versions["eliza-help-getting-started"]).toBe(2);
    expect(versions["eliza-help-troubleshooting"]).toBe(2);
    for (const [key, version] of Object.entries(versions)) {
      if (
        key !== "eliza-help-getting-started" &&
        key !== "eliza-help-troubleshooting"
      ) {
        expect(version).toBe(1);
      }
    }
  });

  it("builds one Q&A fragment per entry and joins title, an empty spacer, then fragments", () => {
    for (const [index, doc] of HELP_DOCUMENTS.entries()) {
      const expected = EXPECTED_TOPICS[index];
      const expectedFragments = expected.entries.map((entry) => ({
        text: fragmentText(entry),
      }));
      expect(doc.fragments).toEqual(expectedFragments);

      const fragmentTexts = expectedFragments.map((fragment) => fragment.text);
      // [title, "", ...fragments].join("\\n\\n") inserts a blank line between
      // title and the first Q&A (empty-string spacer), not a single newline.
      expect(doc.text).toBe(
        `${expected.title}\n\n\n\n${fragmentTexts.join("\n\n")}`,
      );
      expect(doc.text.startsWith(`${expected.title}\n\n\n\n`)).toBe(true);
      for (const fragment of doc.fragments) {
        expect(doc.text).toContain(fragment.text);
        expect(fragment).not.toHaveProperty("embedding");
      }
    }
  });

  it("publishes the exact Q&A copy for every topic", () => {
    for (const [index, doc] of HELP_DOCUMENTS.entries()) {
      const expected = EXPECTED_TOPICS[index];
      const questions = doc.fragments.map((fragment) => {
        const match = /^Q: (.+)\nA: (.+)$/s.exec(fragment.text);
        expect(match).not.toBeNull();
        return { question: match?.[1], answer: match?.[2] };
      });
      expect(questions).toEqual(expected.entries);
    }
  });

  it("keeps questions unique across the catalog so retrieval keys do not collide", () => {
    const questions = HELP_DOCUMENTS.flatMap((doc) =>
      doc.fragments.map((fragment) => {
        const match = /^Q: (.+)\nA: /s.exec(fragment.text);
        expect(match).not.toBeNull();
        return match?.[1];
      }),
    );
    expect(questions.length).toBeGreaterThan(0);
    expect(new Set(questions).size).toBe(questions.length);
  });
});
