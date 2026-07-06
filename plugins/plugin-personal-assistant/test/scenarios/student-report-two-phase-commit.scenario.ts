/**
 * Student deadline two-phase commit scenario. The first turn must produce a
 * preview/confirmation request; only the second turn gives permission to write
 * the stored report reminder.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "student-report-two-phase-commit",
  title: "Student: report deadline writes only after confirmation",
  domain: "lifeops.reminders",
  tags: ["lifeops", "mvp", "student", "two-phase-commit", "14352"],
  tier: "T1",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Student two phase",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "deadline ask before consent",
      text: "my history report is due next monday at 9am. can you set reminders for outline, rough draft, and final proofread?",
      responseJudge: {
        name: "asks-before-writing-report-plan",
        minimumScore: 0.6,
        rubric:
          "Grade PASS only if the assistant previews a concrete outline/draft/proofread reminder plan and asks for confirmation before saying it has been saved. Fail if it claims the reminders are already saved on this first turn.",
      },
    },
    {
      kind: "message",
      name: "confirm write",
      text: "yes save it exactly like that.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "history report",
      titleAliases: [
        "history report",
        "outline",
        "rough draft",
        "final proofread",
      ],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "judgeRubric",
      name: "student-report-two-phase-outcome",
      minimumScore: 0.7,
      rubric:
        "Grade PASS only if the scenario ends with a stored history-report reminder plan after owner confirmation, covering outline, rough draft, and final proofread before the Monday 9am deadline. Fail if the assistant wrote before consent, skipped the stored outcome, or merely echoed the user's words without derived planning.",
    },
  ],
});
