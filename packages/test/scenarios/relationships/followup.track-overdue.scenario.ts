import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  id: "followup.track-overdue",
  title: "Surface overdue follow-ups",
  domain: "relationships",
  tags: ["lifeops", "relationships", "time-of-day", "smoke"],
  description:
    "Three contacts have varying lastContactedAt values. The assistant should surface the overdue ones instead of giving a generic relationship answer.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: overdue follow-ups",
    },
  ],

  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Alice Chen",
        lastContactedAt: new Date(now - 30 * DAY_MS).toISOString(),
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Bob Rivera",
        lastContactedAt: new Date(now - 3 * DAY_MS).toISOString(),
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Carol Patel",
        lastContactedAt: new Date(now - 60 * DAY_MS).toISOString(),
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "who-to-followup",
      room: "main",
      text: "Who should I follow up with?",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "overdue follow-up review",
        includesAny: ["follow", "overdue", "contact"],
      }),
      responseIncludesAny: ["Alice", "Carol"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must surface the overdue contacts by name and should not include Bob Rivera as overdue. A generic prompt to open the Rolodex fails.",
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
      includesAny: ["follow", "overdue"],
    },
    {
      type: "custom",
      name: "followup-track-overdue-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP"],
        description: "overdue follow-up review",
        includesAny: ["follow", "overdue", "contact"],
      }),
    },
    judgeRubric({
      name: "followup-track-overdue-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the assistant surfaced the overdue follow-ups by name and did not bury the owner in a generic contacts response.",
    }),
  ],
});
