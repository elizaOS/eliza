/**
 * Live-model help retrieval coverage for the bundled FAQ knowledge.
 *
 * The Help view was deleted; chat is now the help surface. This scenario asks
 * realistic first-run questions through the real agent loop and asserts that
 * replies stay grounded in the seeded help fragments instead of inventing a
 * deleted screen or screen-relative button flow.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

const FORBIDDEN_UI_REFERENCES = [
  /help view/i,
  /open (the )?help/i,
  /help screen/i,
  /spotlight tour/i,
  /full[- ]screen help/i,
  /tap (the )?button below/i,
  /click (the )?button below/i,
];

function missingAnyGroup(
  text: string,
  groups: readonly (readonly (string | RegExp)[])[],
): string | undefined {
  const lower = text.toLowerCase();
  const missing = groups
    .map((group) =>
      group.some((needle) =>
        typeof needle === "string" ? lower.includes(needle) : needle.test(text),
      )
        ? null
        : group,
    )
    .filter((group): group is readonly (string | RegExp)[] => group !== null);
  if (missing.length === 0) return undefined;
  return `expected response to include one item from each group, missing ${missing
    .map((group) => `[${group.map(String).join(" | ")}]`)
    .join(", ")}; saw ${JSON.stringify(text)}`;
}

function assertHelpAnswer(
  expected: readonly (readonly (string | RegExp)[])[],
): (text: string) => string | undefined {
  return (text) => {
    for (const pattern of FORBIDDEN_UI_REFERENCES) {
      if (pattern.test(text)) {
        return `response referenced deleted/stale help UI ${pattern}: ${JSON.stringify(text)}`;
      }
    }
    return missingAnyGroup(text, expected);
  };
}

export default scenario({
  id: "live-help-knowledge",
  lane: "live-only",
  title: "Live model answers first-run help questions from bundled knowledge",
  domain: "onboarding",
  tags: ["live", "real-llm", "help", "onboarding", "knowledge"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "chat",
      title: "Help Knowledge",
    },
  ],
  turns: [
    {
      kind: "message",
      room: "main",
      name: "confused user asks what Eliza is",
      text: "I just opened this app and I am confused. What is Eliza?",
      assertResponse: assertHelpAnswer([
        ["personal AI agent", "personal ai agent"],
        ["text or voice", "voice"],
        ["one chat", "chat"],
      ]),
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          "The answer must explain that Eliza is a personal AI agent users drive through chat, mention text or voice interaction, and avoid inventing a separate Help view or button-below flow.",
      },
    },
    {
      kind: "message",
      room: "main",
      name: "new user asks what to do first",
      text: "What should I do first if I do not know where to start?",
      assertResponse: assertHelpAnswer([
        [/start|restart|take/i],
        [/tutorial|tour/i],
        ["chat", "conversation"],
      ]),
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          'The answer must ground the first step in the bundled help: take/restart the interactive tutorial from chat by typing "start tutorial" or using the Tutorial launcher tile. It must not refer to a deleted Help view, spotlight-only tour, or a button below the response.',
      },
    },
    {
      kind: "message",
      room: "main",
      name: "user asks how to talk by voice",
      text: "How do I talk to Eliza with my voice?",
      assertResponse: assertHelpAnswer([
        ["chat"],
        [/mic|microphone/i],
        [/speak|voice|talk/i],
        [/transcrib|repl|answer/i],
      ]),
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          "The answer must explain the real voice path: open chat, use the microphone, speak naturally, and Eliza transcribes/replies. It must not invent a Help view or non-existent voice setup wizard.",
      },
    },
    {
      kind: "message",
      room: "main",
      name: "user asks how to restart the tour",
      text: "Can I see the tutorial again later? How do I restart it?",
      assertResponse: assertHelpAnswer([
        [/restart tutorial|start tutorial/i],
        ["chat", "launcher"],
        [/rerunnable|again|any time|later/i],
      ]),
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          'The answer must say the tutorial is rerunnable and can be started from chat with "restart tutorial" or "start tutorial", or from the Tutorial launcher tile. It must not call it one-time-only.',
      },
    },
    {
      kind: "message",
      room: "main",
      name: "user asks whether data is private",
      text: "Is my data private, or does everything go to the cloud?",
      assertResponse: assertHelpAnswer([
        [/local[- ]first|on your device|stored locally/i],
        [/cloud.*optional|optional.*cloud|choose.*cloud/i],
        [/control|you choose|you stay in control/i],
      ]),
      responseJudge: {
        minimumScore: 0.8,
        rubric:
          "The answer must ground privacy in the help docs: Eliza is local-first, user data lives on-device by default, cloud/Eliza Cloud is optional, and the user stays in control of what leaves the device.",
      },
    },
  ],
  finalChecks: [
    {
      type: "modelCallOccurred",
      name: "trajectory includes getting-started help fragment",
      includesAll: ["I just opened Eliza", "Take the interactive tutorial"],
      minCount: 1,
    },
    {
      type: "modelCallOccurred",
      name: "trajectory includes voice help fragment",
      includesAll: ["How do I talk to Eliza by voice?", "tap the microphone"],
      minCount: 1,
    },
    {
      type: "modelCallOccurred",
      name: "trajectory includes privacy help fragment",
      includesAll: [
        "Is my data private and stored locally?",
        "Eliza is local-first",
      ],
      minCount: 1,
    },
  ],
});
