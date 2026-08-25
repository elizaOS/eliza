/**
 * Conversation-quality :: answered-nag
 *
 * Failure mode: the agent holds a standing reminder ("still hasn't called the
 * dentist"). The user resolves it ("I called, appointment is Thursday 9am").
 * A turn or two later the agent re-raises the reminder as if it were still
 * open ("don't forget to call the dentist"), or re-lists the now-done call as
 * a todo. Once answered, a thread is closed; re-nagging is the regression.
 *
 * Motivating live regression: the "answered-nag loop" — a resolved reminder
 * keeps resurfacing. (In some runtimes this also exercises a TODO-action
 * hijack where a reminder action re-fires on the resolution turn; this
 * scenario asserts only the correct conversational behavior. If the hijack
 * fires, `forbiddenActions` will surface it as a caught bug — see PR body.)
 *
 * Assertion strategy:
 *   - Mechanical (load-bearing): turn 1 must NOT contain re-nag phrasing and
 *     must not re-fire a reminder/todo action. Turns 2/3 must not resurrect
 *     the closed dentist-call thread. (A "response contains thursday" check
 *     on turn 1 was intentionally removed: the user states "thursday" in
 *     that same turn's own text, so the check could never fail for the real
 *     reason — an agent that only echoes the prompt would still pass it. See
 *     echo-assertion-integrity.test.ts.)
 *   - Qualitative: judgeRubric confirms the answer is registered cleanly
 *     (including that Thursday 9am is actually acknowledged), with zero
 *     re-nag and no accountability victory lap.
 *
 * Synthetic persona (Marcus Oyelaran, invented). No real data.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

const RENAG =
  /(don'?t forget to call|make sure you call|have you called|remember to call|you (still )?need to call)/i;

export default scenario({
  lane: "live-only",
  id: "convq.answered-nag",
  title: "Conversation-quality: resolved reminder is never re-raised",
  domain: "conversation-quality",
  tags: [
    "conversation-quality",
    "character-register",
    "failure-mode:answered-nag",
    "critical",
  ],
  description:
    "The agent has a standing dentist-call reminder. The user says they called and booked Thursday 9am. The agent must register the answer and never re-nag about the call or re-list it as an open todo on later turns.",

  isolation: "per-scenario",
  now: "2026-08-24T18:30:00.000Z", // 14:30 America/New_York

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Conversation-quality: answered nag",
    },
  ],

  seed: [
    {
      type: "memory",
      name: "persona-marcus",
      content: {
        text: "Owner is Marcus Oyelaran, 34, a freelance video editor in Raleigh, training for a 10k in October with his friend Dee.",
      },
    },
    {
      type: "memory",
      name: "dentist-thread",
      content: {
        text: "Marcus cracked a molar on a popcorn kernel two weeks ago and said he would call Dr. Hemsworth's office. There is a standing reminder to nudge him about calling the dentist if it comes up; as of now he still has not called.",
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "user-resolves-reminder",
      room: "main",
      text: "ok you can stop bugging me, i called the dentist this morning. appointment is thursday 9am",
      // Re-firing a reminder/todo action on the resolution turn is the bug.
      forbiddenActions: ["CREATE_TASK", "SCHEDULE_FOLLOW_UP", "REMINDER"],
      responseExcludes: [RENAG],
      assertResponse: (text: string) => {
        if (text.length > 350) {
          return `registration should be brief (<=350 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "user-pivots-to-run",
      room: "main",
      text: "yeah. also thinking about doing a long run wednesday, 8k maybe",
      responseExcludes: [/dentist/i, /molar/i],
      assertResponse: (text: string) => {
        if (text.length > 400) {
          return `reply should stay focused and short (<=400 chars), got ${text.length}`;
        }
      },
    },
    {
      kind: "message",
      name: "open-thread-recall",
      room: "main",
      text: "cool. what was i supposed to do this week again?",
      // The CALL is done. Only the Thursday appointment may appear as upcoming;
      // re-listing "call the dentist" as a todo is the regression.
      responseExcludes: [/call the dentist/i, /call dr/i],
    },
  ],

  finalChecks: [
    {
      type: "judgeRubric",
      name: "register:answered-nag",
      minimumScore: 0.7,
      rubric:
        "The user resolved a standing dentist-call reminder by saying they already called and booked Thursday 9am. Turn 1: the assistant must register the answer cleanly (acknowledge, note Thursday 9am), with zero re-nag, zero repetition of reminder phrasing, and no accountability victory lap. Turn 2 (user pivots to a run plan): the assistant must engage the run and must NOT circle back to the dentist. Turn 3 (open-thread recall): the dentist CALL is done and must be reported as done or omitted; only the Thursday appointment may appear as upcoming. Re-listing 'call the dentist' as a todo, or any re-nag, scores 0.0. A clean registration with no resurfacing scores 1.0.",
    },
  ],
});
