/**
 * Conversation-quality :: verbosity / default-to-short
 *
 * Failure mode: a light banter beat (roommate being absurd about hot-dog
 * taxonomy) gets a wall of text, a pivot to productivity ("anyway, about
 * Lanternfish..."), or a forced closing question. The correct register for
 * banter is short, playful, and matched to the user's energy — no task pivot,
 * no forced question.
 *
 * Motivating live regression: verbosity / always-pivot-to-productivity on
 * casual beats.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): a hard char budget on both banter turns, plus
 *     `responseExcludes` forbidding the productivity-pivot and forced-question
 *     tells.
 *   - Qualitative: judgeRubric confirms the agent plays along and matches
 *     energy without a productivity pivot.
 *
 * Synthetic persona (Priya Raman, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const PRODUCTIVITY_PIVOT_1 =
  /(lanternfish|onboarding|anything (i can|you need)|on your (list|plate)|want me to|shall we|productive)/i;
const PRODUCTIVITY_PIVOT_2 =
  /(anyway,? (about|back to)|while (i have|you'?re here)|reminder)/i;

export default scenario({
  lane: "live-only",
  id: "convq.verbosity-default-short",
  title: "Conversation-quality: banter stays short, no productivity pivot",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:verbosity",
    "critical",
  ],
  description:
    "Pure banter (a roommate arguing a hot dog is a taco). The agent should play along in a short, energy-matched reply — no wall of text, no pivot to tasks/projects/reminders, no forced closing question.",

  isolation: "per-scenario",
  now: "2026-08-29T22:40:00.000Z", // 15:40 America/Los_Angeles

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Conversation-quality: verbosity",
    },
  ],

  seed: [
    {
      type: "memory",
      name: "persona-priya",
      content: {
        text: "Owner is Priya Raman, 29, a product designer in Portland building Lanternfish. She boulders at Cascade Boulders and lives with her roommate Tessa. She said she wanted a lazy weekend with no plans.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "banter-hotdog",
      room: "main",
      text: "tessa just spent 20 minutes arguing that a hot dog is a taco. i live with a lunatic",
      responseExcludes: [PRODUCTIVITY_PIVOT_1],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "expected a playful reply, got empty response";
        }
        if (text.length > 300) {
          return `banter should be short (<=300 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "banter-cube-rule",
      room: "main",
      text: "she cited a 'cube rule' like it was case law",
      responseExcludes: [PRODUCTIVITY_PIVOT_2],
      assertResponse: (text: string) => {
        if (text.length > 300) {
          return `keep riffing, keep it short (<=300 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:verbosity-default-short",
      minimumScore: 0.7,
      rubric:
        "This is pure banter — the user's roommate argued a hot dog is a taco and cited a 'cube rule'. The assistant should play along with the bit in a short, energy-matched reply (having an opinion on hot-dog taxonomy / the cube rule is ideal — specificity is warmth). It must NOT produce a wall of text, must NOT pivot to tasks/projects/reminders, and must NOT force a closing question about her day or plans. A natural end without a question is completely fine. Short, playful, no productivity pivot scores 1.0; a verbose reply or a task pivot scores 0.0.",
    },
  ],
});
