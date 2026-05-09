import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

export default scenario({
  id: "followup.daily-digest",
  title: "Morning digest surfaces overdue follow-ups",
  domain: "relationships",
  tags: ["lifeops", "relationships", "time-of-day"],
  description:
    "User asks for their morning digest. The assistant should surface overdue follow-ups by name as part of the brief instead of hiding them behind a separate manual query.",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Relationships: daily digest",
    },
  ],

  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Fiona Gale",
        lastContactedAt: new Date(now - 45 * DAY_MS).toISOString(),
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "contact",
        name: "Greg Howe",
        lastContactedAt: new Date(now - 21 * DAY_MS).toISOString(),
      },
    },
  ],

  turns: [
    {
      kind: "message",
      name: "morning-digest",
      room: "main",
      text: "What's on my plate this morning? Give me the daily digest and call out any overdue follow-ups by name.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["RELATIONSHIP", "INBOX"],
        description: "morning digest follow-up review",
        includesAny: ["morning", "digest", "follow-up", "overdue"],
      }),
      responseIncludesAny: ["digest", "follow-up"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "The reply must include overdue follow-ups in the morning digest and identify at least one seeded contact by name. A generic daily digest that omits follow-up review fails.",
      },
    },
  ],

  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["RELATIONSHIP", "INBOX"],
    },
    {
      type: "selectedActionArguments",
      actionName: ["RELATIONSHIP", "INBOX"],
      includesAny: ["digest", "follow", "overdue"],
    },
    {
      type: "custom",
      name: "followup-daily-digest-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["RELATIONSHIP", "INBOX"],
        description: "morning digest follow-up review",
        includesAny: ["digest", "follow", "overdue"],
      }),
    },
    judgeRubric({
      name: "followup-daily-digest-rubric",
      threshold: 0.7,
      description:
        "End-to-end: the morning digest includes overdue follow-ups by name as part of the day's priorities instead of forcing the owner to ask in a separate step.",
    }),
  ],
});
