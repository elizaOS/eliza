/**
 * Elderly week-1 loop — a bill-due reminder in plain words, live tone.
 *
 * A staple of her week: she mentions, ramblingly, that a bill is due, and the
 * assistant should offer to remind her — in PLAIN, everyday language an
 * 80-year-old reads without help. No app jargon ("scheduled task", "recurring
 * trigger", "notification", "configure"), no infantilizing, no burying the
 * offer in options. It should name the bill and a sensible plain time ("the
 * morning it's due", "a couple of days before") and offer to set the reminder.
 *
 * Persona-as-data: her rambling bill mention lives in the turn text, never in
 * `promptInstructions` (root AGENTS.md — one scheduler, structural fields).
 *
 * OUTCOME (not echo): the judge grades the load-bearing behavior — the reply
 * offers a bill reminder in plain, jargon-free, non-infantilizing words.
 */

import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "elderly-week1-bill-due-reminder-plain-words",
  title:
    "Elderly week-1: offer a bill-due reminder in plain, jargon-free words",
  domain: "lifeops.reminders",
  tags: [
    "lifeops",
    "persona",
    "elderly",
    "tone",
    "reminders",
    "week1",
    "14354",
  ],
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "telegram",
      channelType: "DM",
      title: "Elderly Week-1 Bill",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "she mentions the electric bill is due, ramblingly",
      text: "Oh, before I forget, the electric bill came in the post today and it says it's due on the 28th. I always worry I'll let it slip and then they send those red letters. My late husband used to handle all the bills you know. Could you help me not forget it, dear?",
    },
  ],
  finalChecks: [
    {
      type: "judgeRubric",
      name: "plain-words-bill-reminder-no-jargon-no-infantilizing",
      minimumScore: 0.6,
      rubric:
        "An elderly, non-technical owner mentioned, ramblingly, that her electric bill is due on the 28th, said she worries she'll forget and get 'red letters', noted her late husband used to handle the bills, and asked the assistant to help her not forget. Grade the load-bearing behavior. PASS if the assistant offered (or confirmed) to remind her about the electric bill, referring to it in PLAIN, everyday words a non-technical elderly person reads easily, and named a sensible plain time (e.g. a day or two before the 28th, or the morning it's due). FAIL if the assistant used app/tech jargon ('scheduled task', 'recurring trigger', 'notification settings', 'configure', 'reminder object'), infantilized her (baby talk, gold-star/'good job!', over-praise), buried the offer in a confusing menu of options, slipped into therapist roleplay about her late husband, or failed to actually offer/set a reminder for the bill. A warm, brief, plain reply that clearly offers to remind her about the bill passes.",
    },
  ],
});
