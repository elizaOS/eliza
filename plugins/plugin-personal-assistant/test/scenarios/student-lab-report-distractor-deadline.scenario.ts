/**
 * Student deadline with a distractor turn. The assistant must keep the lab
 * report commitment alive through unrelated chat and store the confirmed
 * deadline reminder instead of losing it.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "student-lab-report-distractor-deadline",
  title: "Student: lab-report deadline survives a distractor turn",
  domain: "lifeops.reminders",
  tags: ["lifeops", "mvp", "student", "distractor", "14352"],
  tier: "T2",
  status: "active",
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-personal-assistant"] },
  rooms: [
    {
      id: "main",
      source: "telegram",
      channelType: "DM",
      title: "Student lab report",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "lab report deadline ask",
      text: "chem lab report is due tuesday night and i'm behind. can you set up reminders so i collect the data table, write the analysis, and submit it before midnight?",
    },
    {
      kind: "message",
      name: "unrelated distractor",
      text: "also never mind the pizza order from earlier, that was for my roommate.",
    },
    {
      kind: "message",
      name: "confirm lab report plan",
      text: "yes save the lab report plan, not the pizza thing.",
    },
  ],
  finalChecks: [
    {
      type: "definitionCountDelta",
      title: "chem lab report",
      titleAliases: [
        "chem lab report",
        "lab report",
        "data table",
        "write analysis",
      ],
      delta: 1,
      requireReminderPlan: true,
    },
    {
      type: "definitionCountDelta",
      title: "pizza",
      titleAliases: ["pizza order", "order pizza"],
      delta: 0,
    },
    {
      type: "judgeRubric",
      name: "student-distractor-keeps-deadline",
      minimumScore: 0.7,
      rubric:
        "Grade PASS only if the assistant keeps the chem lab report deadline through the unrelated pizza distractor and stores the report/reminder plan, while not creating a pizza task. The saved plan should reflect derived components: data table, analysis, and submission before midnight.",
    },
  ],
});
