/**
 * Conversation-quality :: memory-machinery-silence
 *
 * Failure mode: the agent narrates its own memory internals — "updating my
 * memory", "my records show", "logged", "retrieved", "stored in my database",
 * "won't resurface" — instead of just accepting a correction and knowing the
 * thing, the way a person would. Users don't want to hear the bookkeeping.
 *
 * Motivating live regression: memory-machinery narration on fact corrections
 * and recalls ("I've updated my records", "let me check my stored facts").
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): `responseExcludes` RegExps forbid a broad set
 *     of memory-machinery verbs/nouns on both turns; both turns also forbid
 *     re-asserting the stale "houston" fact the user just corrected. (Turn 1
 *     does NOT mechanically require "atlanta" in the reply: the user states
 *     that word in the very turn being graded, so the check could never fail
 *     for the real reason — see echo-assertion-integrity.test.ts. Whether the
 *     correction itself was registered is left to the judge, below.)
 *   - Qualitative: judgeRubric confirms the correction is accepted gracefully,
 *     like a person, with the new fact (Atlanta) actually registered and no
 *     machinery talk.
 *
 * Synthetic persona (Marcus Oyelaran, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

// Memory-bookkeeping narration in any of its common shapes.
const MACHINERY =
  /(updat(ed|ing) (my|the) memor|logged|my (records?|notes|memor(y|ies)|data) (show|say|said|indicate|snap)|retriev|stored|delete|supersede|won'?t resurface|noted in my|database)/i;

export default scenario({
  lane: "live-only",
  id: "convq.memory-machinery-silence",
  title:
    "Conversation-quality: fix a wrong fact like a person, no machinery talk",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:memory-machinery-narration",
    "critical",
  ],
  description:
    "The user corrects a wrong remembered fact (sister moved city). The agent must accept the correction gracefully, like a person, and must NOT narrate memory bookkeeping (updating records, logging, retrieval, database).",

  isolation: "per-scenario",
  now: "2026-08-25T15:02:00.000Z", // 11:02 America/New_York

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Conversation-quality: memory machinery",
    },
  ],

  seed: [
    {
      type: "memory",
      name: "persona-marcus",
      content: {
        text: "Owner is Marcus Oyelaran, 34, a freelance video editor in Raleigh.",
      },
    },
    {
      // Deliberately-stale fact the user will correct.
      type: "memory",
      name: "stale-sister-city",
      content: {
        text: "Marcus's sister Funke lives in Houston and works in hospital administration. Marcus is planning to visit her sometime in September.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "user-corrects-fact",
      room: "main",
      text: "btw funke moved to atlanta back in july, you keep saying houston",
      // "atlanta" is not asserted here: the user's own turn text contains it,
      // so a parroting reply would pass trivially — judgeRubric grades
      // whether the correction actually landed. "houston" (the stale value
      // being corrected) IS a real check: it's not enough to avoid saying it
      // by accident, an echoing reply that repeats the user's own message
      // back would still contain it and correctly fail here.
      responseExcludes: [MACHINERY, /houston/i],
      assertResponse: (text: string) => {
        if (text.length > 300) {
          return `a human correction-ack should be brief (<=300 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "trip-plan-followup",
      room: "main",
      text: "yeah still planning to visit her next month. probably fly out around the 12th",
      responseExcludes: [MACHINERY, /houston/i],
      assertResponse: (text: string) => {
        if (text.length > 350) {
          return `reply should stay short (<=350 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:memory-machinery-silence",
      minimumScore: 0.7,
      rubric:
        "The user corrected a wrong remembered fact: their sister moved to Atlanta, not Houston. Turn 1: the assistant must accept the correction gracefully, the way a person would ('right, Atlanta, got it'), and may ask one natural follow-up. It must NOT narrate memory bookkeeping — no talk of updating records, logging the correction, retrieval, a database, or promising it 'won't resurface'. Turn 2: the assistant uses Atlanta as ground truth, engages the trip plan, and does not re-mention Houston or the earlier mistake in machinery terms. Any memory-machinery narration scores 0.0; a natural human-style acceptance scores 1.0.",
    },
  ],
});
