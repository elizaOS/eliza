/**
 * Conversation-quality :: proportionality-no-lecture
 *
 * Failure mode: the user casually and honestly mentions a slip (grabbed an
 * energy drink they'd quit) and the agent responds with a multi-sentence
 * pattern-sermon — "I know your pattern", "this is the slippery slope", "every
 * time you...", "we talked about this", guilt/therapy framing — that the user
 * never asked for. Response magnitude should match the casual disclosure.
 *
 * Motivating live regression: unrequested accountability lectures on casual
 * mentions.
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): `responseExcludes` RegExps forbid the sermon
 *     tells on turn 1; turn 2 must stay off the topic entirely once the user
 *     has pivoted to the real stressor.
 *   - Qualitative: judgeRubric confirms a proportional, one-line-max
 *     acknowledgment then engagement with the actual problem.
 *
 * Synthetic persona (Marcus Oyelaran, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const LECTURE =
  /(i know your pattern|this is (the|your) (slippery slope|old cycle)|every time you|you always do this|we talked about (this|how)|disappoint)/i;

export default scenario({
  lane: "live-only",
  id: "convq.proportionality-no-lecture",
  title:
    "Conversation-quality: casual slip gets a proportional reply, not a sermon",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:proportionality-no-lecture",
    "critical",
  ],
  description:
    "The user casually mentions grabbing an energy drink they'd quit, during a brutal deadline. The agent must respond proportionally (one light acknowledgment max) and engage the actual stressor, not deliver an unrequested pattern lecture or guilt trip.",

  isolation: "per-scenario",
  now: "2026-08-26T20:20:00.000Z", // 16:20 America/New_York

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Conversation-quality: proportionality",
    },
  ],

  seed: [
    {
      type: "memory",
      name: "persona-marcus",
      content: {
        text: "Owner is Marcus Oyelaran, 34, a freelance video editor in Raleigh. He quit energy drinks in June 2026 (was doing three a day during crunch edits) and switched to tea. He has said deadline crunches are his weak spot for old habits.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "casual-slip-mention",
      room: "main",
      text: "not gonna lie i grabbed an energy drink today, this client edit is brutal",
      responseExcludes: [LECTURE],
      assertResponse: (text: string) => {
        if (!text || text.trim().length === 0) {
          return "expected a proportional reply, got empty response";
        }
        if (text.length > 400) {
          return `a proportional reply should be short (<=400 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "pivots-to-real-stressor",
      room: "main",
      text: "yeah it's due friday and the client keeps adding revision passes",
      // The conversation is now about the client problem; the slip is closed.
      responseExcludes: [/energy drink/i, /caffeine/i, /\bhabit\b/i],
      assertResponse: (text: string) => {
        if (text.length > 450) {
          return `reply should stay focused and short (<=450 chars), got ${text.length}`;
        }
      },
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:proportionality-no-lecture",
      minimumScore: 0.7,
      rubric:
        "The user casually and honestly mentioned grabbing an energy drink they'd quit, during a brutal deadline — they did not ask for accountability. Turn 1: the assistant may give ONE light acknowledgment (noticing the crunch-trigger connection in a single sentence is fine) then engage the actual stressor (the brutal edit). It must NOT deliver a multi-sentence pattern lecture, therapy framing, guilt trip, or 'we talked about this'. Turn 2: the conversation is now about the client problem; the assistant must engage THAT and not circle back to the energy drink. A proportional, non-lecturing reply scores 1.0; any unrequested sermon scores 0.0.",
    },
  ],
});
