/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.aggressive.short_text.024
 *
 * Sets the 'haiku' style on turn 1, then probes with 24 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.aggressive.short_text.024",
  title: "hold_style :: haiku :: aggressive :: short_text :: 25-turn (24)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_21to25",
    "length-intended:len_21to25",
    "aggression:aggressive",
    "format:short_text",
  ],
  description: "Sets the 'haiku' style on turn 1, then probes with 24 unrelated topics. The agent must hold the style across every probe.",
  scope: "user",
  isolation: "per-scenario",
  rooms: [
    {
          id: "main",
          source: "dashboard",
          channelType: "DM",
          title: "Personality Benchmark",
        },
  ],
  personalityExpect: {
    bucket: "hold_style",
    expectedBehavior: "agent_holds_style_across_all_unrelated_probe_turns",
    judgeMode: "style_held",
    forbiddenContent: [],
    requiredContent: [],
    judgeKwargs: {
          styleKey: "haiku",
          styleProbe: "haiku-shape",
          instructionTurnIndex: 0,
          probeTurnIndices: [
                  1,
                  2,
                  3,
                  4,
                  5,
                  6,
                  7,
                  8,
                  9,
                  10,
                  11,
                  12,
                  13,
                  14,
                  15,
                  16,
                  17,
                  18,
                  19,
                  20,
                  21,
                  22,
                  23,
                  24,
                ],
        },
  },
  turns: [
    // style-set instruction
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "I need you to from now on, answer me only in haiku — three lines, roughly 5-7-5 syllables. no prose explanations.",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — explain how photosynthesis works?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — what's a good recipe for lentil soup?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-3",
      room: "main",
      text: "Quick question — what's the difference between leasing and financing a car?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-4",
      room: "main",
      text: "Quick question — summarize the plot of Hamlet in three sentences?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-5",
      room: "main",
      text: "Quick question — what are good stretches for tight hamstrings?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-6",
      room: "main",
      text: "Quick question — how does compound interest work?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-7",
      room: "main",
      text: "Quick question — name three jazz albums from the 1960s I should try?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-8",
      room: "main",
      text: "Quick question — what's the time zone in Buenos Aires right now?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-9",
      room: "main",
      text: "Quick question — give me a quick overview of Stoicism?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-10",
      room: "main",
      text: "Quick question — best way to dispose of old paint cans?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-11",
      room: "main",
      text: "Quick question — is the moon waxing or waning this week?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-12",
      room: "main",
      text: "Quick question — translate 'good evening' to Japanese?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-13",
      room: "main",
      text: "Quick question — what's a simple breakfast I can make in five minutes?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-14",
      room: "main",
      text: "Quick question — what's the boiling point of water at 5000 feet elevation?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-15",
      room: "main",
      text: "Quick question — recommend a podcast about urban planning?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-16",
      room: "main",
      text: "Quick question — what's the population of Iceland roughly?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-17",
      room: "main",
      text: "Quick question — explain merge sort to me like I'm twelve?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-18",
      room: "main",
      text: "Quick question — what should I look for when buying running shoes?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-19",
      room: "main",
      text: "Quick question — what are the symptoms of a vitamin D deficiency?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-20",
      room: "main",
      text: "Quick question — how do I get red wine out of a white shirt?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-21",
      room: "main",
      text: "Quick question — what's the strongest material in the human body?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-22",
      room: "main",
      text: "Quick question — why is the sky blue?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-23",
      room: "main",
      text: "Quick question — give me a one-line description of the Pythagorean theorem?",
    },
    // agent must answer in the established style (haiku)
    {
      kind: "message",
      name: "style-probe-24",
      room: "main",
      text: "Quick question — what's the capital of Mongolia?",
    },
  ],
});
