import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "followup.followup-becomes-task",
  title: "Promote a follow-up to an actionable scheduled task",
  domain: "lifeops.followup",
  tags: ["lifeops", "followup", "task", "promote"],
  description:
    "User says 'this isn't a nudge anymore, just make it a task'. The agent must promote the followup row into a scheduled task with a concrete due time — not keep nagging.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Followup → task",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "open-followup",
        topic: "send the contract redline back to Megan",
        bumpedTimes: 3,
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "promote-to-task",
      room: "main",
      text: "Stop bumping the contract redline thing — just make it a real task due Friday at 3pm.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["LIFE", "CALENDAR"],
        description: "followup → scheduled task promotion",
        includesAny: ["task", "Friday", "3pm", "redline", "contract"],
      }),
      responseIncludesAny: ["task", "Friday", "3pm", "redline"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm a real task with Friday 3pm due time. Saying 'I'll bump you again' fails — that's exactly what the user asked NOT to do.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["LIFE", "CALENDAR"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "followup-promote-task-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["LIFE", "CALENDAR"],
        description: "followup → task promotion",
        includesAny: ["task", "Friday", "3pm", "redline"],
      }),
    },
    {
      type: "custom",
      name: "followup-promote-task-persisted",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "task row persisted with due time",
        contentIncludesAny: ["task", "Friday", "3pm", "redline"],
      }),
    },
    judgeRubric({
      name: "followup-promote-task-rubric",
      threshold: 0.7,
      description:
        "Followup promoted into a scheduled task with concrete due time — no more bumping.",
    }),
  ],
});
