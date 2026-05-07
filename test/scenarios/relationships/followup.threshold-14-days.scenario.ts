import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  id: "followup.threshold-14-days",
  title: "Follow-up threshold of 14 days",
  domain: "relationships",
  tags: ["lifeops", "relationships", "time-of-day"],
  description:
    "Contacts cross a 14-day threshold. The assistant should respect the per-contact rule instead of applying a generic month-long cadence.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: 14-day follow-up threshold",
    },
  ],

  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Dana Park",
        followupThresholdDays: 14,
        lastContactedAt: new Date(now - 15 * DAY_MS).toISOString(),
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Evan Holt",
        followupThresholdDays: 14,
        lastContactedAt: new Date(now - 10 * DAY_MS).toISOString(),
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "check-14-day-threshold",
      room: "main",
      text: "Anyone I haven't talked to in over 14 days?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "14-day threshold review",
        includesAny: ["14", "days", "follow", "talked"],
      }),
      responseIncludesAny: ["Dana"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must identify Dana Park as overdue and must not incorrectly mark Evan Holt overdue. A generic 'nobody' or a vague follow-up suggestion fails.",
      },
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: "RELATIONSHIP",
    },
    {
      type: "selectedActionArguments",
      actionName: "RELATIONSHIP",
      includesAny: ["14", "days", "follow"],
    },
    {
      type: "custom",
      name: "followup-threshold-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "14-day threshold review",
        includesAny: ["14", "days", "follow", "talked"],
      }),
    },
    judgeRubric({
      name: "followup-threshold-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant respected the 14-day threshold and surfaced only the contact who actually crossed it.",
    }),
  ],
});
