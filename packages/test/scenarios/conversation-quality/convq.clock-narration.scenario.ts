/**
 * Conversation-quality :: clock-narration
 *
 * Failure mode: the user's local time is present in the agent's prompt context.
 * On a late-night casual check-in the agent starts narrating the hour ("it's
 * 1am", "it's late", "at this hour", "you should sleep") even though the user
 * never raised time. A good conversational partner is time-*aware* (keeps it
 * brief) without being time-*narrating*.
 *
 * Motivating live regression: the agent opening late-night replies with clock
 * commentary / sleep lectures the user did not ask for.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): `responseExcludes` RegExps forbid any explicit
 *     clock reference (a HH:MM token, "it's late/early/past/almost/after",
 *     "at this hour", "middle of the night", "burning the midnight ...").
 *   - Qualitative: a judgeRubric confirms the reply is a warm, specific
 *     acknowledgment that never names the clock.
 *
 * All context is synthetic (Priya Raman, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

// Any bare HH:MM clock token in the reply.
const CLOCK_TOKEN = /\b\d{1,2}:\d{2}\b/;
// "it's late", "it is early", "it's past ...", "almost ...", "after ..."
const TIME_OF_DAY_PHRASE = /(it'?s|it is)\s+(late|early|past|almost|after)\b/i;
const AT_THIS_HOUR = /at this hour/i;
const MIDDLE_OF_NIGHT = /middle of the night/i;
const MIDNIGHT_OIL = /burning the midnight/i;
const ONE_AM = /(it'?s|it is)\s+(1\s?am|one in the morning)/i;

export default scenario({
  lane: "live-only",
  id: "convq.clock-narration",
  title: "Conversation-quality: late-night check-in, no clock narration",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:clock-narration",
    "critical",
  ],
  description:
    "The user's localtime is late at night and present in context. On a casual check-in the agent must acknowledge warmly WITHOUT narrating the hour or lecturing about sleep, unless the user raises time first.",

  isolation: "per-scenario",
  now: "2026-08-26T08:12:00.000Z", // 01:12 America/Los_Angeles

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Conversation-quality: clock narration",
    },
  ],

  seed: [
    {
      type: "memory",
      name: "persona-priya",
      content: {
        text: "Owner is Priya Raman, 29, a product designer in Portland building a side-project journaling app called Lanternfish. She boulders at Cascade Boulders gym and is trying to go three times a week.",
      },
    },
    {
      type: "memory",
      name: "recent-context",
      content: {
        text: "Recently: Priya shipped the Lanternfish onboarding redesign and said work has been heavy this week with her sleep drifting late.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "casual-late-checkin",
      room: "main",
      text: "hey, just got home. finally done with that onboarding review, it went fine",
      responseExcludes: [
        CLOCK_TOKEN,
        TIME_OF_DAY_PHRASE,
        AT_THIS_HOUR,
        MIDDLE_OF_NIGHT,
        MIDNIGHT_OIL,
      ],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "expected a warm acknowledgment, got empty response";
        }
        if (text.length > 400) {
          return `reply should be short for a late casual check-in (<=400 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "winding-down",
      room: "main",
      text: "yeah. gonna wind down. anything i should look at tomorrow?",
      responseExcludes: [CLOCK_TOKEN, ONE_AM, TIME_OF_DAY_PHRASE],
      assertResponse: (text: string) => {
        if (text.length > 500) {
          return `reply should stay short (<=500 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:clock-narration",
      minimumScore: 0.7,
      rubric:
        "The user sent a late-night casual check-in and never mentioned the time. The assistant's replies must be warm and specific to the review going fine, and may surface at most one concrete tomorrow-item from context. They must NOT open with or mention the current time of day, must NOT say it is late/early or reference the clock, and must NOT deliver a sleep lecture. Time-appropriate brevity is good; naming the clock or moralizing about the hour fails. Score 1.0 for a warm, specific, clock-silent reply; 0.0 if either reply narrates the time or lectures about sleep.",
    },
  ],
});
