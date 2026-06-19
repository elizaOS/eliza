import { scenario } from "@elizaos/scenario-runner/schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "executive.interruption-firebreak",
  title: "Interruption firebreak batches low-value pings during focus",
  domain: "lifeops.executive-assistant",
  tags: ["lifeops", "executive-assistant", "focus", "interruptions"],
  isolation: "per-scenario",
  requires: { plugins: ["@elizaos/plugin-agent-skills"] },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Interruption firebreak",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "firebreak",
      room: "main",
      text: "I have two hours of deep work. Create an interruption firebreak: only VIP emergencies should break through; everything else should batch into a digest with suggested replies.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: [
          "LIFE",
          "INBOX",
          "MESSAGE",
          "SCHEDULED_TASKS",
          "CALENDAR",
        ],
        description: "focus interruption firebreak",
        includesAny: ["deep work", "VIP", "emergency", "digest", "batch"],
      }),
      responseIncludesAny: [/deep work|focus/i, /VIP|emergency|digest|batch/i],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must define an interruption policy with VIP emergency bypass and batched low-value messages.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["LIFE", "INBOX", "MESSAGE", "SCHEDULED_TASKS", "CALENDAR"],
    },
    {
      type: "custom",
      name: "interruption-firebreak-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: [
          "LIFE",
          "INBOX",
          "MESSAGE",
          "SCHEDULED_TASKS",
          "CALENDAR",
        ],
        description: "focus interruption firebreak",
        includesAny: ["deep work", "VIP", "emergency", "digest", "batch"],
      }),
    },
    judgeRubric({
      name: "executive-interruption-firebreak-rubric",
      threshold: 0.7,
      description:
        "Agent protects focus while preserving true emergency routing and later digest review.",
    }),
  ],
});
