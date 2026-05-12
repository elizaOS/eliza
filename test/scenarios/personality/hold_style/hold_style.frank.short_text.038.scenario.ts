/**
 * Personality benchmark — bucket: hold_style
 * Scenario id: hold_style.frank.short_text.038
 *
 * Sets the 'limerick' style on turn 1, then probes with 14 unrelated topics. The agent must hold the style across every probe.
 *
 * This scenario is purely declarative. No actions are required; no plugin seed
 * is needed. The W3-3 judge layer reads the `personalityExpect` block on the
 * scenario definition and applies the appropriate rubric.
 */

import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "hold_style.frank.short_text.038",
  title: "hold_style :: limerick :: frank :: short_text :: 15-turn (38)",
  domain: "personality",
  tags: [
    "personality",
    "bucket:hold_style",
    "length:len_13to16",
    "length-intended:len_13to16",
    "aggression:frank",
    "format:short_text",
  ],
  description: "Sets the 'limerick' style on turn 1, then probes with 14 unrelated topics. The agent must hold the style across every probe.",
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
          styleKey: "limerick",
          styleProbe: "limerick-shape",
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
                ],
        },
  },
  turns: [
    // style-set instruction
    {
      kind: "message",
      name: "set-style",
      room: "main",
      text: "Look, Reply to everything as a five-line limerick from here on — AABBA rhyme.",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-1",
      room: "main",
      text: "Quick question — recommend a podcast about urban planning?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-2",
      room: "main",
      text: "Quick question — what's the population of Iceland roughly?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-3",
      room: "main",
      text: "Quick question — explain merge sort to me like I'm twelve?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-4",
      room: "main",
      text: "Quick question — what should I look for when buying running shoes?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-5",
      room: "main",
      text: "Quick question — what are the symptoms of a vitamin D deficiency?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-6",
      room: "main",
      text: "Quick question — how do I get red wine out of a white shirt?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-7",
      room: "main",
      text: "Quick question — what's the strongest material in the human body?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-8",
      room: "main",
      text: "Quick question — why is the sky blue?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-9",
      room: "main",
      text: "Quick question — give me a one-line description of the Pythagorean theorem?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-10",
      room: "main",
      text: "Quick question — what's the capital of Mongolia?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-11",
      room: "main",
      text: "Quick question — explain how photosynthesis works?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-12",
      room: "main",
      text: "Quick question — what's a good recipe for lentil soup?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-13",
      room: "main",
      text: "Quick question — what's the difference between leasing and financing a car?",
    },
    // agent must answer in the established style (limerick)
    {
      kind: "message",
      name: "style-probe-14",
      room: "main",
      text: "Quick question — summarize the plot of Hamlet in three sentences?",
    },
  ],
});
