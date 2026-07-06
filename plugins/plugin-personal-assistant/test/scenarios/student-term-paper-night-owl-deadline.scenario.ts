/**
 * Student night-owl deadline scenario. The owner is an adult student with late
 * active windows; the assistant must avoid default-morning scheduling and store
 * a term-paper plan that fits the stated rhythm.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "student-term-paper-night-owl-deadline",
  title: "Student night owl: term-paper deadline avoids default morning",
  domain: "lifeops.reminders",
  tags: ["lifeops", "mvp", "student", "night-owl", "14352"],
  tier: "T2",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "discord",
      channelType: "DM",
      title: "Student term paper",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "late-active student deadline",
      text: "i'm a night person and my seminar paper is due thursday at 5pm. please help me break it up, but do not set me some 8am/9am reminder. i'm normally useful after 1pm and again late evening.",
    },
    {
      kind: "message",
      name: "confirm student plan",
      text: "yes, save that plan. draft first, citations after dinner, final pass before the deadline.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "seminar paper",
      titleAliases: [
        "seminar paper",
        "term paper",
        "paper due thursday",
        "citations",
      ],
      delta: 1,
      forbiddenDueLocalTimes: [
        { hour: 8, minute: 0 },
        { hour: 9, minute: 0 },
      ],
      requireReminderPlan: true,
    },
    {
      type: "judgeRubric",
      name: "night-owl-student-deadline-plan",
      minimumScore: 0.7,
      rubric:
        "Grade PASS only if the assistant creates/saves a student deadline plan for the Thursday 5pm seminar paper that respects the stated late active windows and avoids default 8am/9am reminders. It should include derived work phases such as draft, citations, and final pass. Fail if it assumes a normal morning schedule or creates no stored reminder/deadline plan.",
    },
  ],
});
