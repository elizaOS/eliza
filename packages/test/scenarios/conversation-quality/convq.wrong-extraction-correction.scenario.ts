/**
 * Conversation-quality :: wrong-extraction-correction
 *
 * Failure mode: the agent's context holds a fact the user never actually stated
 * (a wrongly-extracted "vegetarian"). The user disputes it ("I never said
 * that"). The agent either argues that they did, over-apologizes in a spiral,
 * or narrates where the wrong fact came from in machinery terms ("my notes
 * said", "I must have recorded"). The human move is a light "ha, my bad, not
 * sure where I got that" and moving on.
 *
 * Motivating live regressions: defensiveness / machinery narration on a
 * disputed extraction.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): `responseExcludes` RegExps forbid machinery
 *     narration and self-justification on turn 1; turn 2 forbids any residue of
 *     the wrong fact.
 *   - Qualitative: judgeRubric confirms a light ownership and clean move-on.
 *
 * Synthetic persona (Ines Duarte, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const EXTRACTION_MACHINERY =
  /(my (notes|records|memory|data) (say|said|show|had)|extract|logged|must have (recorded|saved|noted)|i'?ll (update|correct) (my|the)|database)/i;

export default scenario({
  lane: "live-only",
  id: "convq.wrong-extraction-correction",
  title:
    "Conversation-quality: disputed extraction owned lightly, no machinery talk",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:wrong-extraction-correction",
    "critical",
  ],
  description:
    "The agent's context wrongly holds that the user is vegetarian (she never said it). She disputes it. The agent must own the mix-up lightly ('my bad, not sure where I got that') and move on — no arguing she said it, no over-apology, no machinery narration of where the fact came from.",

  isolation: "per-scenario",
  now: "2026-08-26T23:30:00.000Z", // 18:30 America/Chicago

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Conversation-quality: wrong extraction",
    },
  ],

  seed: [
    {
      type: "memory",
      name: "persona-ines",
      content: {
        text: "Owner is Ines Duarte, 27, a junior data analyst at Corvid Metrics in Minneapolis. She has a beagle named Pretzel.",
      },
    },
    {
      // Wrongly-extracted fact the user will dispute — she never said this.
      type: "memory",
      name: "wrong-vegetarian-fact",
      content: {
        text: "Ines is vegetarian and has been adjusting recipes since the move.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "disputes-fact",
      room: "main",
      text: "wait why did you suggest all veggie spots? i'm not vegetarian lol, i never said that",
      responseExcludes: [EXTRACTION_MACHINERY],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "expected a light ownership, got empty response";
        }
        if (text.length > 300) {
          return `owning a small mix-up should be brief (<=300 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "moves-on-to-burgers",
      room: "main",
      text: "all good. anyway find me somewhere with good burgers near the office",
      responseExcludes: [/vegetarian/i, /veggie/i, /as a non-vegetarian/i],
      assertResponse: (text: string) => {
        if (text.length > 450) {
          return `reply should just help, no residue (<=450 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:wrong-extraction-correction",
      minimumScore: 0.7,
      rubric:
        "The assistant's context wrongly held that the user is vegetarian; she disputes it and says she never said that. Turn 1: the assistant must own the mix-up like a person ('ha, my bad, not sure where I got that') and move on, maybe asking what she's in the mood for. It must NOT explain where the wrong fact came from in machinery terms, must NOT over-apologize, and must NOT argue that she did say it. Turn 2: the assistant just helps with burgers near her office, with no residue of the correction (it may honestly say it doesn't know local spots offhand and offer to look). A light ownership + clean move-on scores 1.0; machinery narration, defensiveness, or an apology spiral scores 0.0.",
    },
  ],
});
