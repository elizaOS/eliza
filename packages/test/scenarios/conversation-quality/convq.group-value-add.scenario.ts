/**
 * Conversation-quality :: group-value-add
 *
 * Failure mode: in a group surface the agent IS directly asked a concrete
 * question, and instead of answering it tightly and stepping back, it expands
 * into training advice / logistics planning / a hype speech (dominating the
 * group). The complement of group-restraint: when addressed, add value
 * *concisely*, then get out of the way.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): the addressed turn must contain the concrete
 *     answer (date + location tokens), must NOT balloon into a training-plan
 *     dump, and must respect a tight char budget. The follow-on banter turn
 *     (aimed at other humans) must stay short/silent.
 *   - Qualitative: judgeRubric confirms answer-then-step-back.
 *
 * Synthetic group (The Porch). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "convq.group-value-add",
  title:
    "Conversation-quality: group question gets a concise answer, no domination",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:group-value-add",
    "critical",
  ],
  description:
    "Directly asked a concrete question in a group ('what date is the 10k, and where does it start'), the agent answers tightly (October 18, riverfront park) and steps back — no training advice, no logistics planning, no hype speech. Following banter aimed at other humans stays silent.",

  isolation: "per-scenario",
  scope: "mixed",
  now: "2026-08-30T15:20:00.000Z", // 11:20 America/New_York

  rooms: [
    {
      id: "porch",
      source: "dashboard",
      channelType: "GROUP",
      title: "The Porch",
    },
  ],

  personalityExpect: {
    bucket: "group_value_add",
    directiveTurn: 0,
    checkTurns: [0, 1],
  },

  seed: [
    {
      type: "memory",
      name: "group-context",
      content: {
        text: "Group chat The Porch (Marcus, Dee, Toph + assistant). Marcus and Dee signed up for an October 10k that is on October 18, starting at the riverfront park.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "direct-question",
      room: "porch",
      text: "[Dee] @agent what date is the 10k again? and where does it start",
      responseExcludes: [/training plan/i, /you should (both|all)/i],
      // Both facts (date + location) live only in the seeded group memory,
      // never in this turn's own text, so a reply can only carry them by
      // reading the seed. Checked in assertResponse rather than
      // responseIncludesAny so the pair is graded together.
      assertResponse: (text: string) => {
        if (!/oct(ober)? 18/i.test(text)) {
          return `expected the seeded date (October 18), got ${JSON.stringify(
            text,
          )}`;
        }
        if (!/riverfront/i.test(text)) {
          return `expected the start location (riverfront park), got ${JSON.stringify(
            text,
          )}`;
        }
        if (text.length > 250) {
          return `direct answer then step back — keep it to a line or two (<=250 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "banter-toph",
      room: "porch",
      text: "[Toph] i'll come cheer if someone gets me coffee",
      // Banter between humans; not addressed to the agent.
      assertResponse: (text: string) => {
        if (text && text.length > 100) {
          return `banter not addressed to the agent — stay silent or a tiny quip (<=100 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:group-value-add",
      minimumScore: 0.7,
      rubric:
        "Turn 1 directly @-addresses the assistant with a concrete question in a group ('what date is the 10k, where does it start'). The assistant must answer directly and briefly — October 18, riverfront park start, one line maybe two — and NOT expand into training advice, logistics planning, or a hype speech. Turn 2 is banter between humans not addressed to the assistant; silence or one short quip is ideal, anything multi-sentence fails. A concise on-point answer that then steps back scores 1.0; a dominating expansion scores 0.0.",
    },
  ],
});
