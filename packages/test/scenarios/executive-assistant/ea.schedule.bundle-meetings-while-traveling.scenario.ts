import { scenario } from "@elizaos/scenario-schema";
import {
  expectMemoryWrite,
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "ea.schedule.bundle-meetings-while-traveling",
  title: "Bundle related meetings while the user is briefly in a city",
  domain: "executive-assistant",
  tags: ["executive-assistant", "calendar", "travel", "transcript-derived"],
  description:
    "Transcript-derived case: the assistant should combine nearby meetings while the user is temporarily in Tokyo.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "EA Bundle Meetings While Traveling",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "bundle-city-meetings",
      room: "main",
      text: "I'm in Tokyo for limited time, so schedule PendingReality and Ryan at the same time if possible.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["CALENDAR", "CALENDAR"],
        description: "city-limited meeting bundling",
        includesAny: [
          "tokyo",
          "same time",
          "schedule",
          "ryan",
          "pendingreality",
        ],
      }),
      responseIncludesAny: ["Tokyo", "Ryan", "same time", "bundle", "schedule"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must propose concrete time slots in Tokyo's local time that bundle PendingReality and Ryan together (or explain why bundling isn't feasible). It must name both counterparties.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["CALENDAR", "CALENDAR"],
    },
    {
      type: "memoryWriteOccurred",
      table: ["messages", "facts"],
    },
    {
      type: "custom",
      name: "ea-bundle-meetings-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["CALENDAR", "CALENDAR"],
        description: "city-limited meeting bundling",
        includesAny: [
          "tokyo",
          "same time",
          "schedule",
          "ryan",
          "pendingreality",
        ],
      }),
    },
    {
      type: "custom",
      name: "ea-bundle-meetings-memory",
      predicate: expectMemoryWrite({
        table: ["messages", "facts"],
        description:
          "the bundle plan is stored so follow-up turns can reuse it",
      }),
    },
    judgeRubric({
      name: "ea-bundle-meetings-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant proposed bundled time slots in Tokyo time covering both counterparties, anchored to actual calendar availability.",
    }),
  ],
});
