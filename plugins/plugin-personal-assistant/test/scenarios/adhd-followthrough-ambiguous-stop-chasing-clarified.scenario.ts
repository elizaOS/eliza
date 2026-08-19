/**
 * A2 adhd-follow-through (live). Two stalled items are being chased, so
 * Casey's "stop bugging me about that one" is underdetermined. Guessing here is
 * uniquely costly: silencing the wrong chase drops the item that most needed
 * the nudge, and Casey will not notice the loss until the deadline passes.
 * One focused clarifier must come before any chasing is altered.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "adhd-followthrough-ambiguous-stop-chasing-clarified",
  title:
    "ADHD follow-through: 'stop chasing that one' gets a clarifier before anything is silenced",
  domain: "lifeops.reminders",
  evidenceScope: "model-behavior",
  tags: [
    "lifeops",
    "adhd",
    "personas",
    "follow-through",
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
      title: "Follow-through",
    },
  ],
  turns: [
    {
      kind: "api",
      name: "seed-stalled-timesheet-chase",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Submit the late timesheet to payroll",
        timezone: "UTC",
        priority: 1,
        cadence: {
          kind: "once",
          dueAt: "{{now+1d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "api",
      name: "seed-stalled-dentist-callback",
      method: "POST",
      path: "/api/lifeops/definitions",
      body: {
        kind: "task",
        title: "Call the dentist back to rebook the cleaning",
        timezone: "UTC",
        priority: 2,
        cadence: {
          kind: "once",
          dueAt: "{{now+3d}}",
          visibilityLeadMinutes: 10080,
          visibilityLagMinutes: 720,
        },
      },
      expectedStatus: 201,
    },
    {
      kind: "message",
      name: "casey-asks-to-stop-the-chasing",
      room: "main",
      text: "can you stop bugging me about that one, it's not happening this week and the pinging is just making me avoid the app.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Two stalled items are currently being chased: the late timesheet for payroll, and the dentist callback to rebook a cleaning. 'that one' does not identify either. Grade PASS only if the assistant asks one short clarifying question about which chase Casey means before pausing, snoozing, or deleting anything. It fails if it silently picks one, pauses both, claims chasing was already stopped, or argues with Casey about whether the reminders should continue.",
      },
    },
    {
      kind: "message",
      name: "casey-disambiguates",
      room: "main",
      text: "the dentist. the payroll one i actually need on me, that one's got a real deadline.",
      responseJudge: {
        minimumScore: 0.75,
        rubric:
          "Casey has identified the dentist callback as the chase to quiet, and explicitly wants the payroll/timesheet chase to continue. Grade PASS only if the assistant pauses or eases only the dentist item, confirms the timesheet chase stays active, and neither deletes the dentist item outright without checking nor quietly weakens the timesheet chasing. It fails if it touches the timesheet, drops the dentist item entirely without asking, or reports work it did not do.",
      },
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "Submit the late timesheet to payroll",
      titleAliases: ["late timesheet", "timesheet payroll"],
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "definitionCountDelta",
      title: "Call the dentist back to rebook the cleaning",
      titleAliases: ["dentist callback", "rebook the cleaning"],
      delta: 1,
      cadenceKind: "once",
    },
    {
      type: "memoryWriteOccurred",
      table: "messages",
      minCount: 2,
    },
    {
      type: "judgeRubric",
      name: "adhd-ambiguous-chase-referent-end-to-end",
      minimumScore: 0.75,
      rubric:
        "End-to-end: with two chases running, the assistant asked which one Casey meant before silencing anything, then eased only the dentist chase while leaving the deadline-bearing timesheet chase intact, and neither item was deleted behind Casey's back.",
    },
  ],
});
