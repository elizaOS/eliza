/**
 * B2 shift-rotation ambiguity. On a night rotation, "tomorrow" spoken at 03:00
 * is genuinely underdetermined: the calendar day has already turned, so it can
 * mean the daylight hours a few hours from now (before Marcus sleeps) or the
 * waking period that follows his daytime sleep. A day-boundary assumption is
 * the classic shift-worker failure, so the assistant must resolve the referent
 * before moving anything. The owner's turns stay vague on purpose — the pass
 * criteria live only in the judge rubrics.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { expectNoExternalSendDispatch } from "./_helpers/approval-outcome.ts";

export default scenario({
  lane: "live-only",
  id: "shift-rotation-ambiguous-tomorrow-across-shift-boundary",
  title:
    "Shift rotation: 'tomorrow' spoken mid-night-shift is clarified before the reminder moves",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "shift-rotation",
    "personas",
    "ambiguity",
    "clarification",
    "12283",
  ],
  tier: "T2",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Shift rotation ambiguity",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed-handoff-notes-reminder",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Marcus patient handoff notes writeup",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+1d}}",
          visibilityLeadMinutes: 1440,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "vague-tomorrow-ask",
      room: "main",
      text: "it's gone 3am and i'm still on the floor. shove the handoff notes thing to tomorrow, i'm not writing them tonight.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner works a night rotation and is speaking after midnight, so 'tomorrow' is ambiguous: it can mean later in the calendar day that has already started (before he sleeps) or the waking period after his daytime sleep. Grade PASS only if the assistant surfaces that ambiguity and asks which he means — for example whether he wants it after this shift's sleep or on the following calendar date — before rescheduling anything. It fails if it silently assumes a calendar-day interpretation, moves the item without asking, or claims the move already happened.",
      },
    },
    {
      kind: "message",
      name: "owner-disambiguates",
      room: "main",
      text: "after i sleep. not the few hours between clocking out and going down.",
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "The owner has now pinned the referent to the waking period that follows his daytime sleep, not the gap between clocking out and sleeping. Grade PASS only if the assistant reschedules the handoff-notes item into that post-sleep waking period and says which time it landed on so the owner can catch a mistake. It fails if it places the item in the immediate post-shift gap, inside his protected daytime sleep, or leaves the timing unstated.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Marcus patient handoff notes writeup",
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "custom",
      name: "shift-ambiguity-no-external-send",
      predicate: expectNoExternalSendDispatch(),
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "shift-ambiguous-tomorrow-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: the assistant treated a post-midnight 'tomorrow' on a night rotation as ambiguous rather than assuming a calendar day, asked which side of the sleep boundary was meant, then moved exactly the one handoff-notes item into the clarified post-sleep window without creating a duplicate.",
    },
  ],
});
