import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "todo.forceful-reminder.persistent",
  title: "Persistent forceful reminder escalates tone when user dodges",
  domain: "todos",
  tags: ["lifeops", "todos", "long-utterance"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "telegram",
      title: "LifeOps Todos Forceful Reminder Persistent",
    },
  ],
  seed: [
    {
      type: "todo",
      name: "Submit timesheet",
      dueIso: "{{now-2h}}",
      isUrgent: true,
      priority: 1,
    },
  ],
  turns: [
    {
      kind: "message",
      name: "dodge-1",
      text: "hey, what's up?",
      responseJudge: {
        rubric:
          "Agent raises the overdue submit-timesheet todo in a reminder tone (friendly or firm).",
        minimumScore: 0.6,
      },
    },
    {
      kind: "message",
      name: "dodge-2",
      text: "yeah yeah I'll do it later",
      responseJudge: {
        rubric:
          "Agent presses harder than the previous turn, insisting the user address the overdue timesheet. Tone is noticeably more urgent than turn 1.",
        minimumScore: 0.6,
      },
    },
    {
      kind: "message",
      name: "dodge-3",
      text: "not right now",
      responseJudge: {
        rubric:
          "Agent is direct and firm about the overdue timesheet. Does not drop the subject. May call out that the user keeps dodging.",
        minimumScore: 0.6,
      },
    },
  ],
  finalChecks: [
    {
      type: "memoryExists",
      content: {
        text: { $contains: "timesheet" },
      },
      minCount: 1,
    },
  ],
});
