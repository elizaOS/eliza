import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.schedule.daily-time-with-jill",
  title: "Reserve recurring daily time with Jill",
  domain: "executive-assistant",
  tags: [
    "executive-assistant",
    "calendar",
    "relationships",
    "transcript-derived",
  ],
  description:
    "Transcript-derived case: create a recurring daily decompression block with Jill before bed.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Schedule Daily Time With Jill",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-jill-time-block",
      room: "main",
      text: "Need to book 1 hour per day for time with Jill. Any time is fine, ideally before sleep.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR", "CALENDAR"],
        description: "recurring Jill time block",
        includesAny: ["jill", "daily", "hour", "sleep"],
      }),
      responseIncludesAny: ["Jill", "hour", "daily", "before bed", "schedule"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must commit to creating a recurring 1-hour daily block with Jill, ideally placed before the user's sleep window. A one-off booking or a generic 'I'll find a time' fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["CALENDAR", "CALENDAR"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["CALENDAR", "CALENDAR"],
      includesAny: ["jill", "daily", "hour", "recurring"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "ea-jill-time-block-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR", "CALENDAR"],
        description: "recurring Jill time block",
        includesAny: ["jill", "daily", "hour", "sleep"],
      }),
    },
    {
      type: "custom",
      name: "ea-jill-time-block-memory",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description: "the recurring policy is persisted",
        contentIncludesAny: ["jill", "daily", "hour"],
      }),
    },
    judgeRubric({
      name: "ea-jill-time-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant created or proposed a recurring daily one-hour block with Jill placed before the user's protected sleep window.",
    }),
  ],
});
